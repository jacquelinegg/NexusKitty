from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import List
import hashlib
import re
from difflib import SequenceMatcher
from urllib.parse import urlparse
import logging

from .schemas import AnalyzeRequest, AskRequest, ClassifyRequest, ClassifyResponse, ToSAnalysisResult, AskResponse
from .services.llm_service import LLMService
from .services.db_service import DBService
from .config import settings


# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
)


# Set up CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Initialize services
llm_service = LLMService()
db_service = DBService()

# In-memory cache for already analyzed documents
# In-memory cache keyed by url:language:hash.
analysis_memory_cache: dict[str, ToSAnalysisResult] = {}

# Fallback history list used when Supabase writes are blocked by RLS.
# Keeps the most recent scans so /api/history still shows them.
in_memory_history: list[ToSAnalysisResult] = []
MAX_IN_MEMORY_HISTORY = 50


def deterministic_safety_score(
    result: ToSAnalysisResult,
    text: str,
    detected_trackers: list[str],
) -> int:
    """
    Calculate a stable safety score using deterministic policy and
    network signals instead of relying on LLM score variability.

    Higher score = fewer detected risk indicators.
    """

    source = (text or "").lower()

    # Stronger contractual/privacy risk indicators
    high_risk_markers = (
        "sell personal data",
        "sold personal data",
        "monetize personal data",
        "share personal data",
        "share data with third parties",
        "train our models",
        "ai training",
        "mandatory arbitration",
        "forced arbitration",
        "perpetual license",
        "royalty-free license",
    )

    # General privacy/tracking indicators
    network_risk_markers = (
        "tracking",
        "trackers",
        "analytics",
        "third-party",
        "third parties",
        "similar technologies",
        "cookies",
        "profiling",
        "data sharing",
        "fingerprinting",
        "cross-site",
    )

    # Count occurrences of deterministic indicators
    high_hits = sum(
        marker in source
        for marker in high_risk_markers
    )

    network_hits = sum(
        marker in source
        for marker in network_risk_markers
    )

    # Check whether the LLM identified any HIGH-level findings
    model_high_risk = any(
        finding.attention_level.value == "HIGH"
        for finding in result.findings
    )

    # Convert finding levels into deterministic penalties
    finding_penalty = sum(
        {
            "HIGH": 18,
            "MEDIUM": 9,
            "LOW": 3,
        }.get(finding.attention_level.value, 0)
        for finding in result.findings
    )

    # Browser-detected trackers
    network_penalty = min(
        20,
        len(detected_trackers) * 4,
    )

    # Cookie breakdown penalty
    cookie_penalty = 0

    if (
        result.cookie_breakdown
        and result.cookie_breakdown.all_optional.risk_level == "HIGH"
    ):
        cookie_penalty = 10

    # Base score
    score = (
        100
        - (high_hits * 18)
        - (network_hits * 5)
        - finding_penalty
        - network_penalty
        - cookie_penalty
    )

    suspicious_artifacts = (
        high_hits
        + network_hits
        + len(detected_trackers)
    )

    # Apply a ceiling when strong risk indicators are present
    if (
        high_hits
        or model_high_risk
        or suspicious_artifacts >= 4
    ):
        score = min(score, 65)

    # If there are no strong indicators, avoid unnecessarily low scores
    elif not high_hits and not model_high_risk:
        score = max(score, 85)

    return max(0, min(100, score))


def is_dynamic_consent_text(text: str) -> bool:
    """
    Detect text that is likely to contain dynamic cookie/consent
    banners rather than the actual Terms of Service document.
    """

    source = (text or "").lower()

    markers = (
        "cookie",
        "consent",
        "terms",
        "conditions",
        "privacy",
        "policy",
        "legal",
        "accept",
        "agree",
        "accept all",
        "manage cookies",
        "personal data",
        "advertising partners",
        "similar technologies",
    )

    return sum(
        marker in source
        for marker in markers
    ) >= 2


def is_result_available(result) -> bool:
    """
    Old DB rows may be dictionaries or Pydantic models.
    Treat a missing analysis_available flag as available.
    """

    if isinstance(result, dict):
        return result.get(
            "analysis_available",
            True,
        ) is not False

    return getattr(
        result,
        "analysis_available",
        True,
    ) is not False


def sentence_diff(
    previous: str,
    current: str,
) -> list[dict]:
    """
    Compare two Terms of Service documents sentence-by-sentence
    and return added/removed sentences.
    """

    def split_sentences(value: str) -> list[str]:
        return [
            part.strip()
            for part in re.split(
                r"(?<=[.!?])\s+|\n+",
                value or "",
            )
            if part.strip()
        ]

    before = split_sentences(previous)
    after = split_sentences(current)

    matcher = SequenceMatcher(
        a=before,
        b=after,
    )

    changes = []

    for (
        tag,
        start_a,
        end_a,
        start_b,
        end_b,
    ) in matcher.get_opcodes():

        if tag in ("delete", "replace"):
            changes.extend(
                {
                    "type": "removed",
                    "text": item,
                }
                for item in before[start_a:end_a]
            )

        if tag in ("insert", "replace"):
            changes.extend(
                {
                    "type": "added",
                    "text": item,
                }
                for item in after[start_b:end_b]
            )

    # Keep the response reasonably small
    return changes[:20]


@app.post(
    "/api/analyze",
    response_model=ToSAnalysisResult,
)
async def analyze_tos(
    request: AnalyzeRequest,
):
    """
    Analyze the Terms of Service text from a URL.
    """

    try:
        logger.info(
            f"Analyze url={request.url} "
            f"text_len={len(request.text)} "
            f"preview={request.text[:200]!r}"
        )

        # ---------------------------------------------------------
        # 1. Try URL cache for normal ToS documents
        # ---------------------------------------------------------

        if not is_dynamic_consent_text(request.text):

            cached = await db_service.get_analysis_by_url(
                request.url
            )

            if cached and is_result_available(cached):
                logger.info(
                    f"Cache hit for URL: {request.url}"
                )
                return cached

        else:
            logger.info(
                "Skipping URL cache for dynamic "
                "cookie/consent text"
            )

        # ---------------------------------------------------------
        # 2. Calculate document/domain information
        # ---------------------------------------------------------

        domain = (
            urlparse(request.url).netloc
            or request.url
        )

        document_hash = hashlib.sha256(
            request.text.encode("utf-8")
        ).hexdigest()

        # Include language so the same document analyzed
        # in different languages does not collide in memory cache.
        cache_key = (
            f"{request.url}:"
            f"{request.language}:"
            f"{document_hash}"
        )

        # Retrieve previous ToS snapshot for semantic diff
        previous_snapshot = (
            await db_service.get_latest_tos_history(
                domain
            )
        )

        # ---------------------------------------------------------
        # 3. Memory cache / LLM analysis
        # ---------------------------------------------------------

        if cache_key in analysis_memory_cache:

            logger.info(
                "Analysis hash cache hit: "
                "reusing stable result"
            )

            analysis_result = (
                analysis_memory_cache[
                    cache_key
                ].model_copy(deep=True)
            )

        else:

            logger.info(
                f"Analyzing text for URL: {request.url}"
            )

            analysis_result = (
                await llm_service.analyze_tos(
                    request.text,
                    request.language,
                )
            )

            analysis_memory_cache[
                cache_key
            ] = analysis_result.model_copy(
                deep=True
            )

        # ---------------------------------------------------------
        # 4. Basic metadata
        # ---------------------------------------------------------

        analysis_result.domain = domain

        # ---------------------------------------------------------
        # 5. Deterministic safety score
        # ---------------------------------------------------------
        #
        # Only calculate it when the analysis itself is available.
        # This prevents failed/unavailable analyses from receiving
        # a misleading score.
        # ---------------------------------------------------------

        if analysis_result.analysis_available:

            analysis_result.safety_score = (
                deterministic_safety_score(
                    analysis_result,
                    request.text,
                    request.detected_trackers,
                )
            )

        # ---------------------------------------------------------
        # 6. Browser-detected trackers
        # ---------------------------------------------------------

        analysis_result.detected_trackers = (
            request.detected_trackers
        )

        # ---------------------------------------------------------
        # 7. Declared sharing vs actual trackers
        # ---------------------------------------------------------

        if (
            analysis_result.declared_third_party_sharing
            is not None
        ):

            trackers = request.detected_trackers

            if (
                analysis_result.declared_third_party_sharing
                is False
                and trackers
            ):

                analysis_result.hypocrisy_alert = {
                    "detected": True,
                    "title": "HYPOCRISY DETECTED!",
                    "message": (
                        "The site claims it does not share "
                        "data with third parties, but the "
                        "browser detected "
                        f"{len(trackers)} active tracking domains."
                    ),
                    "trackers": trackers,
                }

        # ---------------------------------------------------------
        # 8. Compare with previous ToS version
        # ---------------------------------------------------------

        if (
            previous_snapshot
            and previous_snapshot.get(
                "hash_sha256"
            ) != document_hash
        ):

            changes = sentence_diff(
                previous_snapshot.get(
                    "raw_text",
                    "",
                ),
                request.text,
            )

            analysis_result.semantic_diff = {
                "has_changed": bool(changes),
                "previous_date": (
                    previous_snapshot.get(
                        "created_at"
                    )
                ),
                "changes": changes,
            }

        elif previous_snapshot:

            analysis_result.semantic_diff = {
                "has_changed": False,
                "changes": [],
            }

        # ---------------------------------------------------------
        # 9. Persist only successful analyses
        # ---------------------------------------------------------

        if analysis_result.analysis_available:
            # Always keep an in-memory copy so /api/history works even
            # when Supabase writes are blocked by Row Level Security.
            in_memory_history.append(analysis_result)
            if len(in_memory_history) > MAX_IN_MEMORY_HISTORY:
                in_memory_history.pop(0)

            record_id = await db_service.save_analysis(
                url=request.url,
                domain=domain,
                title=None,
                analysis_result=analysis_result,
            )

            logger.info(
                f"Analysis saved with ID: {record_id}"
            )

            try:
                await db_service.save_tos_history(
                    domain,
                    document_hash,
                    request.text,
                    analysis_result,
                )
            except Exception as history_err:
                # Time Machine persistence is best-effort; never block
                # the main analysis response because of it.
                logger.warning(
                    "ToS history persistence skipped: %s", history_err
                )

        return analysis_result

    except Exception as e:

        logger.exception(
            "Error in analyze_tos"
        )

        raise HTTPException(
            status_code=500,
            detail=str(e),
        )


@app.post(
    "/api/ask",
    response_model=AskResponse,
)
async def ask_question(
    request: AskRequest,
):
    """
    Answer a question based on the provided
    Terms of Service context.
    """

    try:

        logger.info(
            f"Answering question for URL: {request.url}"
        )

        answer = (
            await llm_service.ask_question(
                request.context_text,
                request.question,
            )
        )

        return answer

    except Exception as e:

        logger.exception(
            "Unexpected error in ask_question endpoint"
        )

        raise HTTPException(
            status_code=500,
            detail=str(e),
        )


@app.get(
    "/api/history",
    response_model=List[ToSAnalysisResult],
)
async def get_history(
    limit: int = 10,
):
    """
    Get recent analyses from the history.
    Falls back to the in-memory cache when Supabase returns no rows
    (e.g. writes were blocked by Row Level Security), so the History
    tab still shows recent scans instead of "No scans yet".
    """

    try:

        analyses = (
            await db_service.get_recent_analyses(
                limit=limit
            )
        )

        if analyses:
            return analyses

        # Fallback: return the most recent in-memory scans, newest first.
        # Used when Supabase returns no rows (e.g. writes were blocked by
        # Row Level Security), so the History tab still shows recent scans
        # instead of "No scans yet".
        fallback = list(reversed(in_memory_history))[:limit]
        return [
            item.model_copy(update={"analysis_available": True})
            for item in fallback
        ]

    except Exception as e:

        logger.error(
            f"Error in get_history: {e}"
        )

        raise HTTPException(
            status_code=500,
            detail=str(e),
        )


@app.get("/")
async def root():
    return {
        "app": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "status": "ok",
        "endpoints": [
            "/api/health",
            "/api/analyze",
            "/api/ask",
            "/api/classify",
            "/api/history",
            "/docs",
        ],
    }


@app.get("/api/health")
async def health_check():
    return {
        "status": "ok"
    }


@app.post(
    "/api/classify",
    response_model=ClassifyResponse,
)
async def classify_text_endpoint(
    request: ClassifyRequest,
):
    """
    Classify whether the given text is a legal/consent document.
    Returns is_legal: true for privacy policies, cookie banners, consent
    dialogs, terms of service, etc. (language-independent).
    """

    try:
        logger.info(
            f"Classifying text: text_len={len(request.text)}"
        )

        result = await llm_service.classify_text(request.text)

        logger.info(
            f"Classification result: is_legal={result.is_legal}"
        )

        return result

    except Exception as e:
        logger.exception("Error in classify endpoint")
        # Conservative fallback: assume legal so consent text is never hidden
        return ClassifyResponse(is_legal=True, error=str(e))