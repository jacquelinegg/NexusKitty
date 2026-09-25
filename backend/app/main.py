from fastapi import FastAPI, HTTPException

from fastapi.middleware.cors import CORSMiddleware

from typing import List

import hashlib

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

# ============================================================

analysis_memory_cache: dict[str, ToSAnalysisResult] = {}



# ============================================================

# Fallback history

#

# Used when Supabase writes/reads are unavailable.

# ============================================================

in_memory_history: list[ToSAnalysisResult] = []

MAX_IN_MEMORY_HISTORY = 50



# ============================================================

# Recent-page duplicate protection

# ============================================================

RECENT_UNIQUE_LIMIT = 5



def normalize_page_url(url: str) -> str:

    """

    Normalize a page URL for duplicate detection.

    Fragments such as #cookies or #privacy are ignored because

    they normally represent a section of the same page.

    Example:

        [https://example.com/privacy](https://example.com/privacy)

        [https://example.com/privacy#cookies](https://example.com/privacy#cookies)

    are treated as the same page.

    """

    if not url:

        return ""

    parsed = urlparse(url)

    normalized = parsed._replace(

        fragment=""

    ).geturl()

    return normalized.rstrip("/")



def get_result_url(result) -> str | None:

    """

    Get URL from either a dictionary or a Pydantic model.

    """

    if isinstance(result, dict):

        return result.get("url")

    return getattr(result, "url", None)



def is_recently_counted(

    url: str,

    recent_results: list,

    limit: int = RECENT_UNIQUE_LIMIT,

) -> bool:

    """

    Check whether this page is already among the latest

    \`limit\` counted analyses.

    The comparison uses normalized URLs.

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

) -> bool:

    """

    Determine whether a page is already among the latest

    five counted analyses.

    We check BOTH:

    - database history

    - in-memory history

    This makes the duplicate protection work even if Supabase

    is unavailable or its data is temporarily incomplete.

    """

    # --------------------------------------------------------

    # 1. Check database history

    # --------------------------------------------------------

    try:

        recent_db_results = await db_service.get_recent_analyses(

            limit=RECENT_UNIQUE_LIMIT

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

    # 2. Check in-memory history

    # --------------------------------------------------------

    recent_memory_results = list(

        reversed(in_memory_history)

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

        # =====================================================

        # 1. Calculate document hash for content-aware caching

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

        # 9. Persist only successful analyses

        #

        # IMPORTANT:

        #

        # The same page is NOT counted again if it is already

        # among the latest 5 unique pages.

        #

        # Once it falls outside those 5, it can be counted again.

        # =====================================================

        if analysis_result.analysis_available:

            already_recent = (

                await is_page_in_recent_top_five(

                    request.url

                )

            )

            if already_recent:

                logger.info(

                    "Recent duplicate ignored: "

                    f"{normalize_page_url(request.url)}"

                )

                # Do not create another history entry.

                # Do not create another DB record.

                #

                # The analysis itself is still returned to the

                # frontend so the user can see the result.

                return analysis_result

            # =================================================

            # Content-hash dedup: prevent duplicate records when the
            # same page content is re-analyzed (e.g. after iframe
            # consent relay) even if the page is no longer in the
            # recent top-5.

            # =================================================

            already_same_content = False

            try:
                already_same_content = await db_service.analysis_exists_for_hash(
                    request.url, document_hash
                )
            except Exception as hash_err:
                logger.warning("Content-hash dedup check failed: %s", hash_err)

            if already_same_content:
                logger.info(

                    "Content-hash duplicate ignored: "

                    f"{normalize_page_url(request.url)}"

                )

                return analysis_result

            # =================================================

            # New page for the recent TOP 5

            # =================================================

            logger.info(

                "New page added to recent history: "

                f"{normalize_page_url(request.url)}"

            )

            # Always keep an in-memory copy so /api/history

            # works even when Supabase writes are blocked

            # by Row Level Security.

            in_memory_history.append(

                analysis_result

            )

            if (

                len(in_memory_history)

                > MAX_IN_MEMORY_HISTORY

            ):

                in_memory_history.pop(0)

            # =================================================

            # Save analysis

            # =================================================

            record_id = await db_service.save_analysis(

                url=request.url,

                domain=domain,

                title=None,

                analysis_result=analysis_result,

                content_hash=document_hash,

            )

            logger.info(

                f"Analysis saved with ID: {record_id}"

            )

            # =================================================

            # Save ToS history

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

):

    """

    Get recent analyses from the history.

    Falls back to the in-memory cache when Supabase returns

    no rows, so the History tab still shows recent scans.

    """

    try:

        analyses = (

            await db_service.get_recent_analyses(

                limit=limit

            )

        )

        if analyses:

            return analyses

        # =====================================================

        # Fallback

        # =====================================================

        fallback = list(

            reversed(in_memory_history)

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

        # =====================================================

        fallback = list(

            reversed(in_memory_history)

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

    return {

        "status": "ok"

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