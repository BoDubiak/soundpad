from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://soundpad:soundpad@localhost:5432/soundpad"
    upload_dir: Path = Path("uploads")
    public_base_url: str = "http://localhost:8000"
    frontend_origin: str = "http://localhost:5173"
    frontend_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    jwt_secret_key: str = "change-this-secret-in-production"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    refresh_cookie_name: str = "soundpad_refresh_token"
    secure_cookies: bool = False
    youtube_temp_ttl_hours: int = 24
    youtube_cookies_file: str | None = None
    youtube_cookies_from_browser: str | None = None
    youtube_po_token_provider_url: str | None = None

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache
def get_settings() -> Settings:
    return Settings()
