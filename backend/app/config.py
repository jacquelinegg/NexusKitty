from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    # OpenAI API Configuration
    OPENAI_API_KEY: Optional[str] = None
    # Anthropic API Configuration
    ANTHROPIC_API_KEY: Optional[str] = None
    # Supabase Configuration
    SUPABASE_URL: str
    SUPABASE_ANON_KEY: str
    SUPABASE_KEY: Optional[str] = None
    SUPABASE_SERVICE_ROLE_KEY: Optional[str] = None
    # Application Settings
    PROJECT_NAME: str = "NexusKitty"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api"
    # LLM Model Settings
    OPENAI_MODEL: str = "gpt-4o-mini"
    ANTHROPIC_MODEL: str = "claude-3-5-sonnet-20240620"
    # Groq API Configuration
    GROQ_API_KEY: str
    GROQ_MODEL: str = "openai/gpt-oss-120b"
    GEMINI_API_KEY: Optional[str] = None
    GEMINI_MODEL: str = "gemini-3.5-flash-lite"
    # Safety Score Thresholds (for internal use)
    HIGH_SAFETY_SCORE: int = 80
    MEDIUM_SAFETY_SCORE: int = 50

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"

settings = Settings()
