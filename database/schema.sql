-- Table: analyses
CREATE TABLE IF NOT EXISTS public.analyses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    domain TEXT NOT NULL,
    title TEXT,
    safety_score INT CHECK (safety_score BETWEEN 0 AND 100),
    safety_prediction TEXT,
    summary TEXT NOT NULL,
    findings JSONB NOT NULL DEFAULT '[]'::jsonb,
    content_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add safety_prediction column if missing (for existing tables)
ALTER TABLE public.analyses ADD COLUMN IF NOT EXISTS safety_prediction TEXT;

-- Index for fast domain/url caching lookups
CREATE INDEX IF NOT EXISTS idx_analyses_domain ON public.analyses(domain);
CREATE INDEX IF NOT EXISTS idx_analyses_url ON public.analyses(url);
ALTER TABLE public.analyses ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_analyses_content_hash ON public.analyses(content_hash);

-- Versioned legal-document snapshots for the ToS Time Machine.
CREATE TABLE IF NOT EXISTS public.tos_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain TEXT NOT NULL,
    hash_sha256 TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    analysis_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tos_history_domain_created
    ON public.tos_history(domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tos_history_hash
    ON public.tos_history(hash_sha256);