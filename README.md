# Soundpad

MVP soundboard app: create a board, add sound buttons, play them instantly, reorder by drag and drop, and share a public link.

## Stack

- Frontend: React + Vite
- Backend: FastAPI
- Database: PostgreSQL
- Files: local uploads in `backend/uploads`
- Media tools: `ffmpeg` and `yt-dlp` for YouTube audio clips

## Quick Start

1. Copy environment files:

```powershell
Copy-Item .env.example .env
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env
```

2. Start PostgreSQL:

```powershell
docker compose up -d db
```

3. Run backend:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

4. Run frontend:

```powershell
cd frontend
npm install
npm run dev
```

Frontend defaults to `http://localhost:5173`, backend to `http://localhost:8000`.

For YouTube clips, install `ffmpeg` and make sure `ffmpeg`/`ffprobe` are available in `PATH`.
Prepared YouTube source files are deleted after a clip is created. Abandoned source files are removed after
`YOUTUBE_TEMP_TTL_HOURS` hours (24 by default) on backend startup, hourly, and before each new YouTube preparation.

The production Docker stack runs a private `bgutil` PO Token Provider and configures `yt-dlp` to request fresh
tokens automatically. No manual token or cookie setup is required for ordinary public videos. The provider is
only reachable inside the Compose network. The backend image also includes Deno, `yt-dlp-ejs`, and browser
impersonation support for YouTube's JavaScript challenges.

Cookies remain an optional fallback for age-restricted or account-only videos. Export fresh YouTube cookies in
Netscape `cookies.txt` format and set `YOUTUBE_COOKIES_FILE` in `backend/.env`. For local development, you can
instead set `YOUTUBE_COOKIES_FROM_BROWSER=chrome` (or `edge`/`firefox`) to read cookies from a browser on the
backend machine. Stop the browser first if its cookie database is locked, and never commit the cookie file.

## GitHub

Commit source code and examples:

- `backend/app/`
- `backend/requirements.txt`
- `frontend/src/`
- `frontend/package.json`
- `frontend/package-lock.json`
- `frontend/*.ts`
- `frontend/*.js`
- `frontend/index.html`
- `.env.example`
- `backend/.env.example`
- `frontend/.env.example`
- `docker-compose.yml`
- `README.md`
- `.gitignore`

Do not commit local runtime files:

- `.env`, `backend/.env`, `frontend/.env`
- `backend/.venv/`
- `frontend/node_modules/`
- `frontend/dist/`
- `backend/uploads/`
- `*.log`

Before publishing, set a real `JWT_SECRET_KEY` in deployment secrets instead of committing it.

## Core Features

- Create and rename a soundboard
- Upload audio files or add a sound by URL
- Play sounds from buttons
- Keyboard hotkeys
- Drag and drop reordering
- Public share link via board ID
- Audio preloading on the client
- User accounts with email/password login
- JWT access tokens with httpOnly refresh-token cookies

## Deployment

- OVH VPS setup: [`DEPLOY_OVH.md`](DEPLOY_OVH.md)
- GitHub Actions CI/CD: [`CICD.md`](CICD.md)
