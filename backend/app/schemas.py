import uuid
from datetime import datetime

from pydantic import BaseModel, Field, HttpUrl, field_validator


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if "@" not in cleaned or "." not in cleaned.rsplit("@", 1)[-1]:
            raise ValueError("Enter a valid email address")
        return cleaned


class UserRead(BaseModel):
    id: uuid.UUID
    email: str
    created_at: datetime

    model_config = {"from_attributes": True}


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead


class SoundCreate(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    file_url: HttpUrl
    image_url: HttpUrl | None = None
    hotkey: str | None = Field(default=None, max_length=1)


class SoundUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=80)
    file_url: HttpUrl | None = None
    image_url: HttpUrl | None = None
    hotkey: str | None = Field(default=None, max_length=1)


class SoundRead(BaseModel):
    id: uuid.UUID
    title: str
    file_url: str
    image_url: str | None
    hotkey: str | None
    order: int
    created_at: datetime

    model_config = {"from_attributes": True}


class SoundboardCreate(BaseModel):
    title: str = Field(default="Untitled board", min_length=1, max_length=120)
    image_url: HttpUrl | None = None


class SoundboardUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    image_url: HttpUrl | None = None
    is_public: bool | None = None


class SoundboardRead(BaseModel):
    id: uuid.UUID
    owner_id: uuid.UUID | None
    title: str
    image_url: str | None
    is_public: bool
    created_at: datetime
    updated_at: datetime
    sounds: list[SoundRead]

    model_config = {"from_attributes": True}


class ReorderRequest(BaseModel):
    sound_ids: list[uuid.UUID]


class YoutubePrepareRequest(BaseModel):
    url: str = Field(min_length=8, max_length=500)


class YoutubePrepareResponse(BaseModel):
    source_id: uuid.UUID
    title: str
    duration: float
    audio_url: str


class YoutubeClipRequest(BaseModel):
    source_id: uuid.UUID
    title: str = Field(min_length=1, max_length=80)
    start: float = Field(ge=0)
    duration: float = Field(gt=0, le=60)
    image_url: HttpUrl | None = None
    hotkey: str | None = Field(default=None, max_length=1)
