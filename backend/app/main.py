import asyncio
import json
import shutil
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Cookie, Depends, FastAPI, File, Form, HTTPException, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from app.auth import (
    clear_refresh_cookie,
    consume_refresh_token,
    create_access_token,
    create_refresh_token,
    get_current_user,
    hash_password,
    hash_refresh_token,
    normalize_email,
    set_refresh_cookie,
    verify_password,
)
from app.config import get_settings
from app.database import Base, engine, get_db
from app.models import RefreshToken, Sound, Soundboard, User
from app.schemas import (
    AuthResponse,
    ReorderRequest,
    SoundCreate,
    SoundRead,
    SoundUpdate,
    SoundboardCreate,
    SoundboardRead,
    SoundboardUpdate,
    UserCreate,
    UserRead,
    YoutubeClipRequest,
    YoutubeFrameOption,
    YoutubeFramesRequest,
    YoutubeFramesResponse,
    YoutubePrepareRequest,
    YoutubePrepareResponse,
)

settings = get_settings()
settings.upload_dir.mkdir(parents=True, exist_ok=True)
youtube_dir = settings.upload_dir / "youtube"
youtube_dir.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Soundpad API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.frontend_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")


@app.on_event("startup")
async def on_startup() -> None:
    cleanup_stale_youtube_sources()
    Base.metadata.create_all(bind=engine)
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE sounds ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)"))
        connection.execute(text("ALTER TABLE soundboards ADD COLUMN IF NOT EXISTS owner_id UUID"))
        connection.execute(text("ALTER TABLE soundboards ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_soundboards_owner_id ON soundboards (owner_id)"))
    app.state.youtube_cleanup_task = asyncio.create_task(run_youtube_cleanup())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    cleanup_task = getattr(app.state, "youtube_cleanup_task", None)
    if cleanup_task is not None:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass


def get_board_or_404(board_id: uuid.UUID, db: Session) -> Soundboard:
    stmt = (
        select(Soundboard)
        .where(Soundboard.id == board_id)
        .options(selectinload(Soundboard.sounds))
    )
    board = db.scalar(stmt)
    if board is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Soundboard not found")
    return board


def get_owned_board_or_404(board_id: uuid.UUID, user: User, db: Session) -> Soundboard:
    board = get_board_or_404(board_id, db)
    if board.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Soundboard not found")
    return board


def can_copy_sound(source_sound: Sound, user: User, db: Session) -> bool:
    source_board = db.get(Soundboard, source_sound.soundboard_id)
    return bool(source_board and (source_board.is_public or source_board.owner_id == user.id))


def next_order(board_id: uuid.UUID, db: Session) -> int:
    sounds = db.scalars(select(Sound).where(Sound.soundboard_id == board_id)).all()
    if not sounds:
        return 0
    return max(sound.order for sound in sounds) + 1


def public_upload_url(path: Path) -> str:
    relative_path = path.relative_to(settings.upload_dir).as_posix()
    return f"{settings.public_base_url}/uploads/{relative_path}"


def run_process(command: list[str], failure_detail: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, capture_output=True, check=True, text=True)
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Required media tool is not installed. Install yt-dlp and ffmpeg.",
        ) from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip() or failure_detail
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail) from error


def probe_audio_duration(path: Path) -> float:
    result = run_process(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        "Could not read audio duration",
    )
    try:
        return max(0.0, float(result.stdout.strip()))
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Could not read audio duration") from error


def get_youtube_source_path(source_id: uuid.UUID) -> Path | None:
    preferred_path = youtube_dir / f"{source_id}.mp3"
    if preferred_path.is_file():
        return preferred_path
    for path in youtube_dir.glob(f"{source_id}.*"):
        if path.is_file() and path.suffix.lower() in {".mp3", ".m4a", ".opus", ".ogg", ".wav", ".webm"}:
            return path
    return None


def youtube_metadata_path(source_id: uuid.UUID) -> Path:
    return youtube_dir / f"{source_id}.json"


def get_youtube_source_url(source_id: uuid.UUID) -> str:
    metadata_path = youtube_metadata_path(source_id)
    try:
        source_url = json.loads(metadata_path.read_text(encoding="utf-8"))["url"]
    except (FileNotFoundError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prepared YouTube video metadata not found. Prepare the video again.",
        ) from error
    if not isinstance(source_url, str) or not source_url.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Prepared YouTube video metadata is invalid. Prepare the video again.",
        )
    return source_url


def delete_youtube_frame_assets(source_id: uuid.UUID, include_previews: bool = True) -> None:
    patterns = [f"{source_id}.frame.*"]
    if include_previews:
        patterns.append(f"{source_id}.preview.*")
    for pattern in patterns:
        for path in youtube_dir.glob(pattern):
            if path.is_file():
                path.unlink(missing_ok=True)


def download_youtube_frame_section(
    source_id: uuid.UUID,
    source_url: str,
    start: float,
    duration: float,
) -> Path:
    delete_youtube_frame_assets(source_id)
    section_end = start + max(0.5, min(duration, 60))
    frame_template = youtube_dir / f"{source_id}.frame.%(ext)s"
    run_process(
        [
            sys.executable,
            "-m",
            "yt_dlp",
            "--quiet",
            "--no-warnings",
            "--no-playlist",
            "--download-sections",
            f"*{start:.3f}-{section_end:.3f}",
            "--force-keyframes-at-cuts",
            "--format",
            "bestvideo[height<=720]/bestvideo/best[height<=720]/best",
            "--output",
            str(frame_template),
            source_url,
        ],
        "Could not download the YouTube frame source",
    )

    frame_sources = [
        path
        for path in youtube_dir.glob(f"{source_id}.frame.*")
        if path.is_file() and path.suffix.lower() not in {".part", ".ytdl"}
    ]
    if not frame_sources:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Could not prepare the YouTube frame")
    return frame_sources[0]


def extract_video_frame(source_path: Path, offset: float, output_path: Path) -> None:
    run_process(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source_path),
            "-ss",
            f"{max(0, offset):.3f}",
            "-frames:v",
            "1",
            "-vf",
            "scale=640:640:force_original_aspect_ratio=decrease",
            "-q:v",
            "3",
            str(output_path),
        ],
        "Could not extract the YouTube frame",
    )


def create_youtube_frame(source_id: uuid.UUID, source_url: str, start: float, output_path: Path) -> None:
    try:
        frame_source = download_youtube_frame_section(source_id, source_url, start, 2)
        extract_video_frame(frame_source, 0, output_path)
    finally:
        delete_youtube_frame_assets(source_id, include_previews=False)


def delete_youtube_source(source_id: uuid.UUID) -> None:
    for path in youtube_dir.glob(f"{source_id}.*"):
        if path.is_file():
            path.unlink(missing_ok=True)


def cleanup_stale_youtube_sources() -> None:
    cutoff = time.time() - max(1, settings.youtube_temp_ttl_hours) * 60 * 60
    for path in youtube_dir.iterdir():
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except FileNotFoundError:
            # Another request may have removed the same temporary file.
            continue


async def run_youtube_cleanup() -> None:
    while True:
        await asyncio.sleep(60 * 60)
        cleanup_stale_youtube_sources()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/auth/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, response: Response, db: Session = Depends(get_db)) -> AuthResponse:
    email = normalize_email(payload.email)
    existing_user = db.scalar(select(User).where(User.email == email))
    if existing_user is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email is already registered")

    user = User(email=email, password_hash=hash_password(payload.password))
    db.add(user)
    db.flush()
    refresh_token = create_refresh_token(user, db)
    db.commit()
    db.refresh(user)
    set_refresh_cookie(response, refresh_token)
    return AuthResponse(access_token=create_access_token(user), user=user)


@app.post("/auth/login", response_model=AuthResponse)
def login(payload: UserCreate, response: Response, db: Session = Depends(get_db)) -> AuthResponse:
    email = normalize_email(payload.email)
    user = db.scalar(select(User).where(User.email == email))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

    refresh_token = create_refresh_token(user, db)
    db.commit()
    set_refresh_cookie(response, refresh_token)
    return AuthResponse(access_token=create_access_token(user), user=user)


@app.post("/auth/refresh", response_model=AuthResponse)
def refresh_session(
    user: User = Depends(consume_refresh_token),
    db: Session = Depends(get_db),
) -> AuthResponse:
    db.commit()
    return AuthResponse(access_token=create_access_token(user), user=user)


@app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    refresh_token: str | None = Cookie(default=None, alias=settings.refresh_cookie_name),
    db: Session = Depends(get_db),
) -> None:
    if refresh_token:
        token = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(refresh_token)))
        if token is not None and token.revoked_at is None:
            token.revoked_at = datetime.now(UTC)
            db.commit()
    clear_refresh_cookie(response)


@app.post("/auth/logout-all", status_code=status.HTTP_204_NO_CONTENT)
def logout_all(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    db.query(RefreshToken).filter(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None)).update(
        {"revoked_at": datetime.now(UTC)},
        synchronize_session=False,
    )
    db.commit()


@app.get("/auth/me", response_model=UserRead)
def read_me(user: User = Depends(get_current_user)) -> User:
    return user


@app.post("/soundboards", response_model=SoundboardRead, status_code=status.HTTP_201_CREATED)
def create_soundboard(
    payload: SoundboardCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Soundboard:
    board = Soundboard(
        title=payload.title.strip(),
        image_url=str(payload.image_url) if payload.image_url else None,
        owner_id=user.id,
    )
    db.add(board)
    db.commit()
    db.refresh(board)
    return board


@app.get("/soundboards", response_model=list[SoundboardRead])
def list_soundboards(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Soundboard]:
    stmt = (
        select(Soundboard)
        .where(Soundboard.owner_id == user.id)
        .options(selectinload(Soundboard.sounds))
        .order_by(Soundboard.updated_at.desc(), Soundboard.created_at.desc())
    )
    return list(db.scalars(stmt).all())


@app.get("/soundboards/public/search", response_model=list[SoundboardRead])
def search_public_soundboards(
    q: str = "",
    db: Session = Depends(get_db),
) -> list[Soundboard]:
    query = q.strip()
    if len(query) < 2:
        return []

    stmt = (
        select(Soundboard)
        .where(Soundboard.is_public.is_(True), Soundboard.title.ilike(f"%{query}%"))
        .options(selectinload(Soundboard.sounds))
        .order_by(Soundboard.updated_at.desc(), Soundboard.created_at.desc())
        .limit(20)
    )
    return list(db.scalars(stmt).all())


@app.get("/soundboards/{board_id}/manage", response_model=SoundboardRead)
def manage_soundboard(
    board_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Soundboard:
    return get_owned_board_or_404(board_id, user, db)


@app.post("/soundboards/{board_id}/save", response_model=SoundboardRead, status_code=status.HTTP_201_CREATED)
def save_public_soundboard(
    board_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Soundboard:
    source_board = get_board_or_404(board_id, db)
    if not source_board.is_public:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Soundboard not found")
    if source_board.owner_id == user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Soundboard is already in your list")

    board = Soundboard(
        title=source_board.title,
        image_url=source_board.image_url,
        is_public=False,
        owner_id=user.id,
    )
    db.add(board)
    db.flush()
    for source_sound in sorted(source_board.sounds, key=lambda sound: sound.order):
        db.add(
            Sound(
                soundboard_id=board.id,
                title=source_sound.title,
                file_url=source_sound.file_url,
                image_url=source_sound.image_url,
                hotkey=source_sound.hotkey,
                order=source_sound.order,
            )
        )

    db.commit()
    return get_board_or_404(board.id, db)


@app.get("/soundboards/{board_id}", response_model=SoundboardRead)
def read_soundboard(board_id: uuid.UUID, db: Session = Depends(get_db)) -> Soundboard:
    board = get_board_or_404(board_id, db)
    if not board.is_public:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Soundboard not found")
    return board


@app.patch("/soundboards/{board_id}", response_model=SoundboardRead)
def update_soundboard(
    board_id: uuid.UUID,
    payload: SoundboardUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Soundboard:
    board = get_owned_board_or_404(board_id, user, db)
    if payload.title is not None:
        board.title = payload.title.strip()
    if "image_url" in payload.model_fields_set:
        board.image_url = str(payload.image_url) if payload.image_url else None
    if payload.is_public is not None:
        board.is_public = payload.is_public
    db.commit()
    db.refresh(board)
    return get_board_or_404(board_id, db)


@app.delete("/soundboards/{board_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_soundboard(
    board_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    board = get_owned_board_or_404(board_id, user, db)
    db.delete(board)
    db.commit()


@app.post("/soundboards/{board_id}/sounds", response_model=SoundRead, status_code=status.HTTP_201_CREATED)
def add_sound_by_url(
    board_id: uuid.UUID,
    payload: SoundCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Sound:
    get_owned_board_or_404(board_id, user, db)
    sound = Sound(
        soundboard_id=board_id,
        title=payload.title.strip(),
        file_url=str(payload.file_url),
        image_url=str(payload.image_url) if payload.image_url else None,
        hotkey=payload.hotkey.upper() if payload.hotkey else None,
        order=next_order(board_id, db),
    )
    db.add(sound)
    db.commit()
    db.refresh(sound)
    return sound


@app.post("/soundboards/{board_id}/sounds/upload", response_model=SoundRead, status_code=status.HTTP_201_CREATED)
def upload_sound(
    board_id: uuid.UUID,
    title: str = Form(..., min_length=1, max_length=80),
    hotkey: str | None = Form(default=None, max_length=1),
    image_url: str | None = Form(default=None, max_length=500),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Sound:
    get_owned_board_or_404(board_id, user, db)
    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only audio files are supported")

    extension = Path(file.filename or "").suffix.lower() or ".mp3"
    filename = f"{uuid.uuid4()}{extension}"
    path = settings.upload_dir / filename
    with path.open("wb") as target:
        shutil.copyfileobj(file.file, target)

    sound = Sound(
        soundboard_id=board_id,
        title=title.strip(),
        file_url=f"{settings.public_base_url}/uploads/{filename}",
        image_url=image_url.strip() if image_url else None,
        hotkey=hotkey.upper() if hotkey else None,
        order=next_order(board_id, db),
    )
    db.add(sound)
    db.commit()
    db.refresh(sound)
    return sound


@app.post("/youtube/prepare", response_model=YoutubePrepareResponse)
def prepare_youtube_audio(
    payload: YoutubePrepareRequest,
    user: User = Depends(get_current_user),
) -> YoutubePrepareResponse:
    _ = user
    cleanup_stale_youtube_sources()
    try:
        from yt_dlp import YoutubeDL
    except ImportError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="yt-dlp is not installed. Install backend requirements and make sure ffmpeg is available.",
        ) from error

    source_id = uuid.uuid4()
    output_template = str(youtube_dir / f"{source_id}.%(ext)s")
    try:
        with YoutubeDL(
            {
                "format": "bestaudio/best",
                "noplaylist": True,
                "outtmpl": output_template,
                "quiet": True,
                "no_warnings": True,
                "postprocessors": [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "mp3",
                        "preferredquality": "192",
                    }
                ],
            }
        ) as downloader:
            info = downloader.extract_info(payload.url.strip(), download=True)
    except Exception as error:
        delete_youtube_source(source_id)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Could not download YouTube audio: {error}") from error

    audio_path = youtube_dir / f"{source_id}.mp3"
    if not audio_path.exists():
        matched_path = get_youtube_source_path(source_id)
        if matched_path is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Could not prepare YouTube audio")
        audio_path = matched_path

    duration = float(info.get("duration") or probe_audio_duration(audio_path))
    title = str(info.get("title") or "YouTube sound")[:80]
    youtube_metadata_path(source_id).write_text(
        json.dumps({"url": payload.url.strip()}),
        encoding="utf-8",
    )
    return YoutubePrepareResponse(
        source_id=source_id,
        title=title,
        duration=duration,
        audio_url=public_upload_url(audio_path),
    )


@app.post("/youtube/frames", response_model=YoutubeFramesResponse)
def generate_youtube_frames(
    payload: YoutubeFramesRequest,
    user: User = Depends(get_current_user),
) -> YoutubeFramesResponse:
    _ = user
    source_path = get_youtube_source_path(payload.source_id)
    if source_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Prepared YouTube audio not found")

    source_duration = probe_audio_duration(source_path)
    if payload.start >= source_duration:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Clip start is outside the audio duration")
    clip_duration = min(payload.duration, source_duration - payload.start)
    if clip_duration <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Clip duration is too short")

    source_url = get_youtube_source_url(payload.source_id)
    last_offset = max(0, clip_duration - min(0.15, clip_duration / 10))
    offsets = [0.0, clip_duration / 3, clip_duration * 2 / 3, last_offset]
    frames: list[YoutubeFrameOption] = []

    try:
        frame_source = download_youtube_frame_section(
            payload.source_id,
            source_url,
            payload.start,
            clip_duration,
        )
        for index, offset in enumerate(offsets):
            preview_path = youtube_dir / f"{payload.source_id}.preview.{index}.jpg"
            extract_video_frame(frame_source, offset, preview_path)
            frames.append(
                YoutubeFrameOption(
                    index=index,
                    timestamp=payload.start + offset,
                    image_url=public_upload_url(preview_path),
                )
            )
    except Exception:
        delete_youtube_frame_assets(payload.source_id)
        raise
    finally:
        delete_youtube_frame_assets(payload.source_id, include_previews=False)

    return YoutubeFramesResponse(frames=frames)


@app.post("/soundboards/{board_id}/sounds/youtube", response_model=SoundRead, status_code=status.HTTP_201_CREATED)
def add_youtube_clip(
    board_id: uuid.UUID,
    payload: YoutubeClipRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Sound:
    get_owned_board_or_404(board_id, user, db)
    source_path = get_youtube_source_path(payload.source_id)
    if source_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Prepared YouTube audio not found")

    source_duration = probe_audio_duration(source_path)
    if payload.start >= source_duration:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Clip start is outside the audio duration")
    clip_duration = min(payload.duration, source_duration - payload.start)
    if clip_duration <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Clip duration is too short")

    file_id = uuid.uuid4()
    filename = f"{file_id}.mp3"
    output_path = settings.upload_dir / filename
    run_process(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{payload.start:.3f}",
            "-i",
            str(source_path),
            "-t",
            f"{clip_duration:.3f}",
            "-vn",
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "4",
            str(output_path),
        ],
        "Could not create YouTube clip",
    )

    image_url = str(payload.image_url) if payload.image_url else None
    image_path: Path | None = None
    if image_url is None:
        image_path = settings.upload_dir / f"{file_id}.jpg"
        try:
            if payload.frame_index is not None:
                preview_path = youtube_dir / f"{payload.source_id}.preview.{payload.frame_index}.jpg"
                if not preview_path.is_file():
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Selected YouTube frame not found. Generate the frame options again.",
                    )
                shutil.copyfile(preview_path, image_path)
            else:
                create_youtube_frame(
                    payload.source_id,
                    get_youtube_source_url(payload.source_id),
                    payload.start,
                    image_path,
                )
            image_url = public_upload_url(image_path)
        except Exception:
            output_path.unlink(missing_ok=True)
            image_path.unlink(missing_ok=True)
            raise

    sound = Sound(
        soundboard_id=board_id,
        title=payload.title.strip(),
        file_url=public_upload_url(output_path),
        image_url=image_url,
        hotkey=payload.hotkey.upper() if payload.hotkey else None,
        order=next_order(board_id, db),
    )
    db.add(sound)
    db.commit()
    db.refresh(sound)
    delete_youtube_source(payload.source_id)
    return sound


@app.post(
    "/soundboards/{board_id}/sounds/copy/{source_sound_id}",
    response_model=SoundRead,
    status_code=status.HTTP_201_CREATED,
)
def copy_sound(
    board_id: uuid.UUID,
    source_sound_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Sound:
    get_owned_board_or_404(board_id, user, db)
    source_sound = db.get(Sound, source_sound_id)
    if source_sound is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source sound not found")
    if not can_copy_sound(source_sound, user, db):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source sound not found")
    if source_sound.soundboard_id == board_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Sound is already on this board")

    sound = Sound(
        soundboard_id=board_id,
        title=source_sound.title,
        file_url=source_sound.file_url,
        image_url=source_sound.image_url,
        hotkey=None,
        order=next_order(board_id, db),
    )
    db.add(sound)
    db.commit()
    db.refresh(sound)
    return sound


@app.patch("/soundboards/{board_id}/sounds/{sound_id}", response_model=SoundRead)
def update_sound(
    board_id: uuid.UUID,
    sound_id: uuid.UUID,
    payload: SoundUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Sound:
    get_owned_board_or_404(board_id, user, db)
    sound = db.get(Sound, sound_id)
    if sound is None or sound.soundboard_id != board_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sound not found")
    updated_fields = payload.model_fields_set
    if "title" in updated_fields and payload.title is not None:
        sound.title = payload.title.strip()
    if "file_url" in updated_fields and payload.file_url is not None:
        sound.file_url = str(payload.file_url)
    if "image_url" in updated_fields:
        sound.image_url = str(payload.image_url) if payload.image_url else None
    if "hotkey" in updated_fields:
        sound.hotkey = payload.hotkey.upper() if payload.hotkey else None
    db.commit()
    db.refresh(sound)
    return sound


@app.delete("/soundboards/{board_id}/sounds/{sound_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sound(
    board_id: uuid.UUID,
    sound_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    get_owned_board_or_404(board_id, user, db)
    sound = db.get(Sound, sound_id)
    if sound is None or sound.soundboard_id != board_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sound not found")
    db.delete(sound)
    db.commit()


@app.post("/soundboards/{board_id}/sounds/reorder", response_model=SoundboardRead)
def reorder_sounds(
    board_id: uuid.UUID,
    payload: ReorderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Soundboard:
    board = get_owned_board_or_404(board_id, user, db)
    existing_ids = {sound.id for sound in board.sounds}
    incoming_ids = set(payload.sound_ids)
    if incoming_ids != existing_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reorder list must include every sound")

    sounds_by_id = {sound.id: sound for sound in board.sounds}
    for index, sound_id in enumerate(payload.sound_ids):
        sounds_by_id[sound_id].order = index

    db.commit()
    return get_board_or_404(board_id, db)
