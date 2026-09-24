from supabase import create_client, Client
from .config import settings
import logging

logger = logging.getLogger(__name__)

# Singleton Supabase client
supabase: Client = None


def get_supabase() -> Client:
    global supabase
    if supabase is None:
        # The backend MUST use the service role key so that inserts bypass
        # Row Level Security. Falling back to the anon/publishable key
        # silently fails on every write (analyses + tos_history), which is
        # why the history page always shows "No scans yet".
        key = (
            settings.SUPABASE_SERVICE_ROLE_KEY
            or settings.SUPABASE_KEY
            or settings.SUPABASE_ANON_KEY
        )
        if not key:
            raise RuntimeError(
                "No Supabase key configured. Set SUPABASE_SERVICE_ROLE_KEY "
                "(preferred) or SUPABASE_KEY in backend/.env."
            )
        if not settings.SUPABASE_SERVICE_ROLE_KEY and (
            settings.SUPABASE_KEY or settings.SUPABASE_ANON_KEY
        ):
            logger.warning(
                "Supabase is using a non-service key (%s). Writes to "
                "analyses/tos_history will be blocked by Row Level Security. "
                "Set SUPABASE_SERVICE_ROLE_KEY in backend/.env to fix history "
                "persistence.",
                "SUPABASE_KEY" if settings.SUPABASE_KEY else "SUPABASE_ANON_KEY",
            )
        supabase = create_client(settings.SUPABASE_URL, key)
    return supabase