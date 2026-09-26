from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional
import hashlib
import os
import re
from difflib import SequenceMatcher
from urllib.parse import urlparse
import logging
from .schemas import (
    AnalyzeRequest,
    AskRequest,
    ClassifyRequest,
    ClassifyResponse,
    ToSAnalysisResult,
    AskResponse,
    safety_prediction_label,
    SemanticDiff,
    SemanticChange,
)
from .services.llm_service import LLMService
from .services.db_service import DBService
from .config import settings

# ============================================================
# Configure logging
# ============================================================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ============================================================
# FastAPI
# ============================================================
app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
)

# ============================================================
# CORS
# ============================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# Services
# ============================================================
llm_service = LLMService()
db_service = DBService()

# ============================================================
# In-memory cache for already analyzed documents
#
# Key:
# url:language:hash
#
# NOTE: this cache is deliberately shared across every client_id.
# It only stores the LLM's read of a given ToS document (same text
# in -> same structured findings out), never who visited it, so
# sharing it across installations just saves LLM calls and is not
# a privacy leak the way the history list was.
# ============================================================
analysis_memory_cache: dict[str, ToSAnalysisResult] = {}

# ============================================================
# Fallback history
#
# Used when Supabase writes/reads are unavailable.
#
# FIX (privacy bug): this used to be one flat list of
# ToSAnalysisResult shared by every browser/profile that hit this
# backend, so /api/history (and its in-memory fallback) leaked
# other installations' browsing history to whoever asked - which is
# exactly what was seen when the extension was installed on a
# second Google profile and it showed someone else's sesame.bg /
# winbet.bg scans.
#
# Now each entry also carries the client_id of the installation
# that produced it, and every read path filters by the requesting
# client_id.
# ============================================================
in_memory_history: list[dict] = []  # [{"client_id": str, "result": ToSAnalysisResult}, ...]
MAX_IN_MEMORY_HISTORY = 50

# ============================================================
# Recent-page duplicate protection
# ============================================================
RECENT_UNIQUE_LIMIT = 5


# ============================================================
# Per-installation identity
#
# The extension generates a random UUID once (chrome.storage.local)
# and sends it as X-Client-Id on every request. It is NOT a login
# and identifies nothing about the person - it just keeps one
# installation's history separate from everyone else's who happens
# to share this backend/API key.
#
# Requests from older extension builds that don't send the header
# yet fall back to a single shared "legacy-shared" bucket so they
# don't crash - update the extension to stop sharing history.
# ============================================================
LEGACY_CLIENT_ID = "legacy-shared"


async def get_client_id(
    x_client_id: Optional[str] = Header(default=None, alias="X-Client-Id"),
) -> str:
    return x_client_id or LEGACY_CLIENT_ID


def normalize_page_url(url: str) -> str:
    """
    Normalize a page URL for duplicate detection.
    Fragments such as #cookies or #privacy are ignored because
    they normally represent a section of the same page.
    Example:
        https://example.com/privacy
        https://example.com/privacy#cookies
    are treated as the same page.
    """
    if not url:
        return ""
    parsed = urlparse(url)
    normalized = parsed._replace(
        fragment=""
    ).geturl()
    return normalized.rstrip("/")


def get_result_url(entry) -> str | None:
    """
    Get URL from an in_memory_history entry ({"client_id", "result"}),
    a raw dict, or a Pydantic model - kept flexible since some legacy
    callers below still pass bare results.
    """
    if isinstance(entry, dict) and "result" in entry:
        return get_result_url(entry["result"])
    if isinstance(entry, dict):
        return entry.get("url")
    return getattr(entry, "url", None)


def is_recently_counted(
    url: str,
    recent_results: list,
    limit: int = RECENT_UNIQUE_LIMIT,
) -> bool:
    """
    Check whether this page is already among the latest
    `limit` counted analyses.
    The comparison uses normalized URLs.

    NOTE: kept for reference / potential reuse elsewhere. The main
    analyze_tos() flow no longer uses this to silently SKIP a
    revisit - see the MRU reorder logic in step 9 below, which
    replaced the old skip-without-reordering behaviour.
    """
    current_url = normalize_page_url(url)
    if not current_url:
        return False

    checked = 0
    for result in recent_results:
        if checked >= limit:
            break
        previous_url = get_result_url(result)
        if not previous_url:
            continue
        checked += 1
        if normalize_page_url(previous_url) == current_url:
            return True
    return False


async def is_page_in_recent_top_five(
    url: str,
    client_id: str,
) -> bool:
    """
    Determine whether a page is already among the latest
    five counted analyses FOR THIS CLIENT ONLY.

    We check BOTH:
    - database history
    - in-memory history

    This makes the duplicate protection work even if Supabase
    is unavailable or its data is temporarily incomplete.

    NOTE: kept for reference / potential reuse elsewhere; no longer
    called from analyze_tos() (see step 9 below).
    """
    # --------------------------------------------------------
    # 1. Check database history (scoped to this client_id)
    # --------------------------------------------------------
    try:
        recent_db_results = await db_service.get_recent_analyses(
            limit=RECENT_UNIQUE_LIMIT,
            client_id=client_id,
        )
        if recent_db_results:
            if is_recently_counted(
                url,
                recent_db_results,
                RECENT_UNIQUE_LIMIT,
            ):
                return True
    except Exception as err:
        logger.warning(
            "Could not check recent DB history: %s",
            err,
        )

    # --------------------------------------------------------
    # 2. Check in-memory history (scoped to this client_id)
    # --------------------------------------------------------
    own_entries = [
        entry for entry in in_memory_history
        if entry.get("client_id") == client_id
    ]
    recent_memory_results = list(
        reversed(own_entries)
    )[:RECENT_UNIQUE_LIMIT]
    if is_recently_counted(
        url,
        recent_memory_results,
        RECENT_UNIQUE_LIMIT,
    ):
        return True

    return False


# ============================================================
# Deterministic safety score
# ============================================================
def deterministic_safety_score(
    result: ToSAnalysisResult,
    text: str,
    detected_trackers: list[str],
) -> int:
    """
    Calculate a safety prediction score (0-100) that represents
    the likelihood a site's legal document is safe for ordinary users.
    Higher score = safer.

    The score is deterministic: same inputs always produce
    the same output.
    """
    source = (text or "").lower()

    # --------------------------------------------------------
    # Strong contractual/privacy risk indicators
    # --------------------------------------------------------
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

    # --------------------------------------------------------
    # General privacy/tracking indicators
    # --------------------------------------------------------
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

    # --------------------------------------------------------
    # Count occurrences of deterministic indicators
    # --------------------------------------------------------
    high_hits = sum(
        marker in source
        for marker in high_risk_markers
    )
    network_hits = sum(
        marker in source
        for marker in network_risk_markers
    )

    # --------------------------------------------------------
    # Check whether the LLM identified HIGH-level findings
    # --------------------------------------------------------
    model_high_risk = any(
        finding.attention_level.value == "HIGH"
        for finding in result.findings
    )

    # --------------------------------------------------------
    # Convert finding levels into deterministic penalties
    # --------------------------------------------------------
    finding_penalty = sum(
        {
            "HIGH": 18,
            "MEDIUM": 9,
            "LOW": 3,
        }.get(
            finding.attention_level.value,
            0,
        )
        for finding in result.findings
    )

    # --------------------------------------------------------
    # Browser-detected trackers
    # --------------------------------------------------------
    network_penalty = min(
        20,
        len(detected_trackers) * 4,
    )

    # --------------------------------------------------------
    # Cookie breakdown penalty
    # --------------------------------------------------------
    cookie_penalty = 0
    if (
        result.cookie_breakdown
        and result.cookie_breakdown.all_optional.risk_level == "HIGH"
    ):
        cookie_penalty = 10

    # --------------------------------------------------------
    # Base score
    # --------------------------------------------------------
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

    # --------------------------------------------------------
    # Apply ceiling when strong risk indicators are present
    # --------------------------------------------------------
    if (
        high_hits
        or model_high_risk
        or suspicious_artifacts >= 4
    ):
        score = min(score, 65)
    # --------------------------------------------------------
    # If there are no strong indicators, avoid unnecessarily
    # low scores.
    # --------------------------------------------------------
    elif not high_hits and not model_high_risk:
        score = max(score, 85)

    return max(
        0,
        min(100, score),
    )


# ============================================================
# Dynamic consent detection
# ============================================================
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


# ============================================================
# Analysis availability
# ============================================================
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


# ============================================================
# Sentence diff
# ============================================================
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


# ============================================================
# ANALYZE
# ============================================================
@app.post(
    "/api/analyze",
    response_model=ToSAnalysisResult,
)
async def analyze_tos(
    request: AnalyzeRequest,
    client_id: str = Depends(get_client_id),
):
    """
    Analyze the Terms of Service text from a URL.
    """
    try:
        logger.info(
            f"Analyze client={client_id} url={request.url} "
            f"text_len={len(request.text)} "
            f"preview={request.text[:200]!r}"
        )

        # =====================================================
        # 1. Calculate document hash for content-aware caching
        #
        # This URL+hash cache is intentionally shared across every
        # client_id: it only reuses the LLM's read of the *document
        # text itself* (same ToS -> same findings), never anyone's
        # browsing history, so sharing it just saves LLM calls.
        # =====================================================
        document_hash = hashlib.sha256(
            request.text.encode("utf-8")
        ).hexdigest()

        if not is_dynamic_consent_text(request.text):
            cached = await db_service.get_analysis_by_url_and_hash(
                request.url,
                document_hash,
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

        # =====================================================
        # 2. Calculate document/domain information
        # =====================================================
        domain = (
            urlparse(request.url).netloc
            or request.url
        )

        # Include language so the same document analyzed
        # in different languages does not collide in memory cache.
        cache_key = (
            f"{request.url}:"
            f"{request.language}:"
            f"{document_hash}"
        )

        # =====================================================
        # Retrieve previous ToS snapshot for semantic diff
        # (global by domain - comparing versions of the same
        # public document, not personal data, so this stays
        # unscoped by client_id on purpose)
        # =====================================================
        previous_snapshot = (
            await db_service.get_latest_tos_history(
                domain
            )
        )

        # =====================================================
        # 3. Memory cache / LLM analysis
        # =====================================================
        if cache_key in analysis_memory_cache:
            logger.info(
                "Analysis hash cache hit: "
                "reusing stable result"
            )
            analysis_result = (
                analysis_memory_cache[
                    cache_key
                ].model_copy(
                    deep=True
                )
            )
        else:
            logger.info(
                f"Analyzing text for URL: {request.url}"
            )
            analysis_result = (
                await llm_service.analyze_tos(
                    request.text,
                    request.language,
                    translated_text=request.translated_text,
                    detected_language=request.detected_language,
                )
            )
            analysis_memory_cache[
                cache_key
            ] = analysis_result.model_copy(
                deep=True
            )

        # =====================================================
        # 4. Basic metadata
        # =====================================================
        analysis_result.domain = domain
        analysis_result.url = request.url

        # =====================================================
        # 5. Deterministic safety score
        # =====================================================
        if analysis_result.analysis_available:
            analysis_result.safety_score = (
                deterministic_safety_score(
                    analysis_result,
                    request.text,
                    request.detected_trackers,
                )
            )
            analysis_result.safety_prediction = (
                safety_prediction_label(
                    analysis_result.safety_score
                )
            )

        # =====================================================
        # 6. Browser-detected trackers
        # =====================================================
        analysis_result.detected_trackers = (
            request.detected_trackers
        )

        # =====================================================
        # 7. Declared sharing vs actual trackers
        # =====================================================
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

        # =====================================================
        # 8. Compare with previous ToS version
        # =====================================================
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

            analysis_result.semantic_diff = SemanticDiff(
                has_changed=bool(changes),
                previous_date=previous_snapshot.get("created_at"),
                changes=[SemanticChange(**c) for c in changes],
            )

        elif previous_snapshot:

            analysis_result.semantic_diff = SemanticDiff(
                has_changed=False,
                previous_date=previous_snapshot.get("created_at"),
                changes=[],
            )

        # =====================================================
        # 9. Persist / reorder history entries (MRU), PER CLIENT
        #
        # IMPORTANT - MRU (most-recently-used) behaviour:
        #
        # Every time a page is analyzed - whether it's a brand-new
        # page, or a page whose ToS/Privacy text hasn't changed
        # since an earlier visit (even a much earlier one, already
        # outside the visible window) - it must be bumped to the
        # FRONT (most-recent) position of the history THIS CLIENT
        # sees.
        #
        # FIX (this pass): everything here used to operate on one
        # global list/table shared by every installation, so one
        # person's History tab showed another person's browsing
        # (e.g. sesame.bg / winbet.bg appearing on a fresh Google
        # profile). Every read/write below is now scoped by
        # client_id - a random per-installation UUID sent as
        # X-Client-Id, not a login and not tied to identity.
        # =====================================================

        if analysis_result.analysis_available:

            normalized_url = normalize_page_url(request.url)

            # ---- MRU bump: in-memory history (this client only) ----
            # Drop any existing entry for this exact page BY THIS
            # CLIENT, then re-append so it lands in the most-recent
            # slot (get_history() reverses this list). Entries
            # belonging to other client_ids are left untouched.
            in_memory_history[:] = [
                entry for entry in in_memory_history
                if not (
                    entry.get("client_id") == client_id
                    and normalize_page_url(get_result_url(entry)) == normalized_url
                )
            ]
            in_memory_history.append({
                "client_id": client_id,
                "result": analysis_result,
            })
            if len(in_memory_history) > MAX_IN_MEMORY_HISTORY:
                in_memory_history.pop(0)

            # ---- Same page re-opened moments apart, even with a
            #      slightly different content_hash?
            #
            # Extraction timing/partial-DOM capture can make two
            # back-to-back opens of the exact same page produce
            # slightly different text (and therefore a different
            # content_hash) even though nothing about the page's
            # actual ToS/privacy content changed. Without this check,
            # each such open created its own history row - e.g.
            # opening runners.bg twice in a row showing up as two
            # separate entries with different issue counts. If this
            # client already has a row for this URL from within the
            # last few minutes, overwrite it in place instead of
            # inserting a new one. ----
            recent_row = None
            try:
                recent_row = await db_service.get_recent_row_for_client_url(
                    request.url, client_id=client_id, minutes=10
                )
            except Exception as recent_err:
                logger.warning(
                    "Recent-row lookup failed for %s: %s",
                    normalized_url,
                    recent_err,
                )

            if recent_row and recent_row.get("content_hash") != document_hash:
                logger.info(
                    "Collapsing near-duplicate re-analysis (extraction "
                    "variance) into existing row %s for client %s: %s",
                    recent_row["id"],
                    client_id,
                    normalized_url,
                )
                updated = await db_service.update_analysis(
                    recent_row["id"], analysis_result, content_hash=document_hash
                )
                if updated:
                    return analysis_result
                # If the update failed for some reason, fall through and
                # let the normal insert path below create a fresh row
                # rather than silently dropping the analysis.

            # ---- Has THIS CLIENT already saved this exact content for this URL? ----
            already_same_content = False

            try:
                already_same_content = await db_service.analysis_exists_for_hash(
                    request.url, document_hash, client_id=client_id
                )
            except Exception as hash_err:
                logger.warning("Content-hash dedup check failed: %s", hash_err)

            if already_same_content:

                logger.info(
                    "Content-hash duplicate for client %s: bumping recency without a new DB row: %s",
                    client_id,
                    normalized_url,
                )

                # Best-effort: bump this client's existing row to the
                # front of the DB-backed history too, without
                # creating a duplicate record.
                try:
                    await db_service.touch_analysis_recency(
                        request.url, client_id=client_id
                    )
                except AttributeError:
                    logger.warning(
                        "db_service.touch_analysis_recency() is not implemented - "
                        "DB-backed history order will not reflect this revisit "
                        "until it is added."
                    )
                except Exception as touch_err:
                    logger.warning(
                        "Failed to bump recency for %s: %s",
                        normalized_url,
                        touch_err,
                    )

                # The analysis itself is still returned to the
                # frontend so the user can see the result.
                return analysis_result

            # =================================================
            # Genuinely new/changed content: persist normally,
            # tagged with this client's id
            # =================================================

            logger.info(
                "New/changed page saved to history for client %s: %s",
                client_id,
                normalized_url,
            )

            # =================================================
            # Save analysis
            # =================================================
            record_id = await db_service.save_analysis(
                url=request.url,
                domain=domain,
                title=None,
                analysis_result=analysis_result,
                content_hash=document_hash,
                client_id=client_id,
            )

            logger.info(
                f"Analysis saved with ID: {record_id}"
            )

            # =================================================
            # Save ToS history (global by domain - see note above)
            # =================================================
            try:
                await db_service.save_tos_history(
                    domain,
                    document_hash,
                    request.text,
                    analysis_result,
                )
            except Exception as history_err:
                # Time Machine persistence is best-effort;
                # never block the main analysis response.
                logger.warning(
                    "ToS history persistence skipped: %s",
                    history_err,
                )

        # =====================================================
        # Return result
        # =====================================================
        return analysis_result

    except Exception as e:
        logger.exception(
            "Error in analyze_tos"
        )
        raise HTTPException(
            status_code=500,
            detail=str(e),
        )


# ============================================================
# ASK
# ============================================================
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
                request.history,
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


# ============================================================
# HISTORY
# ============================================================
@app.get(
    "/api/history",
    response_model=List[ToSAnalysisResult],
)
async def get_history(
    limit: int = 10,
    client_id: str = Depends(get_client_id),
):
    """
    Get recent analyses from the history, SCOPED TO THIS CLIENT.

    Falls back to the in-memory cache when Supabase returns
    no rows, so the History tab still shows recent scans - but
    only this installation's own scans, never anyone else's.
    """
    try:
        analyses = (
            await db_service.get_recent_analyses(
                limit=limit,
                client_id=client_id,
            )
        )

        if analyses:
            return analyses

        # =====================================================
        # Fallback (this client's in-memory entries only)
        # =====================================================
        own_entries = [
            entry["result"] for entry in in_memory_history
            if entry.get("client_id") == client_id
        ]
        fallback = list(
            reversed(own_entries)
        )[:limit]
        return [
            item.model_copy(
                update={
                    "analysis_available": True
                }
            )
            for item in fallback
        ]

    except Exception as e:
        logger.error(
            f"Error in get_history: {e}"
        )
        # =====================================================
        # If DB completely fails, still use memory history
        # (this client's own entries only)
        # =====================================================
        own_entries = [
            entry["result"] for entry in in_memory_history
            if entry.get("client_id") == client_id
        ]
        fallback = list(
            reversed(own_entries)
        )[:limit]
        return [
            item.model_copy(
                update={
                    "analysis_available": True
                }
            )
            for item in fallback
        ]


# ============================================================
# ROOT
# ============================================================
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


# ============================================================
# HEALTH
# ============================================================
@app.get("/api/health")
async def health_check():
    # Render injects RENDER_GIT_COMMIT into every build, so this endpoint is
    # the only reliable way to tell WHICH build is actually serving traffic.
    # "local" means the process is not running on Render, or was started
    # without Render's build metadata.
    return {
        "status": "ok",
        "version": settings.VERSION,
        "commit": os.environ.get("RENDER_GIT_COMMIT", "local"),
    }


# ============================================================
# CLASSIFY
# ============================================================
@app.post(
    "/api/classify",
    response_model=ClassifyResponse,
)
async def classify_text_endpoint(
    request: ClassifyRequest,
):
    """
    Classify whether the given text is a legal/consent document.
    Returns is_legal: true for privacy policies, cookie banners,
    consent dialogs, terms of service, etc.
    """
    try:
        logger.info(
            f"Classifying text: "
            f"text_len={len(request.text)}"
        )

        result = await llm_service.classify_text(
            request.text
        )

        logger.info(
            f"Classification result: "
            f"is_legal={result.is_legal}"
        )

        return result

    except Exception as e:
        logger.exception(
            "Error in classify endpoint"
        )
        # Conservative fallback:
        # assume legal so consent text is never hidden.
        return ClassifyResponse(
            is_legal=True,
            error=str(e),
        )