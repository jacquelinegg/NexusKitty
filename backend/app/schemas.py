from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field


class AttentionLevel(str, Enum):
    HIGH = "HIGH"       # Red flag / Critical issue
    MEDIUM = "MEDIUM"   # Yellow / Warning
    LOW = "LOW"         # Green / Informational


class ClauseCategory(str, Enum):
    MONEY = "MONEY"               # Hidden fees, subscriptions, refunds
    PRIVACY = "PRIVACY"           # Data selling, tracking, third parties
    USER_CONTENT = "USER_CONTENT" # Ownership of user uploads, IP rights
    AI_USAGE = "AI_USAGE"         # Training AI on user data
    TERMINATION = "TERMINATION"   # Account deletion, sudden ban rights
    DATA_SALE = "DATA_SALE"       # Sale or monetization of personal data


class CookieOptionDetail(BaseModel):
    label: str = Field(..., description="Button label, e.g. 'Allow essential cookies' or 'Allow all'")
    data_collected: List[str] = Field(default_factory=list, description="Types of data/cookies collected under this choice")
    risk_level: str = Field("LOW", description="Risk assessment: LOW, MEDIUM, or HIGH")


class CookieBreakdown(BaseModel):
    essential: CookieOptionDetail
    all_optional: CookieOptionDetail


class Finding(BaseModel):
    category: ClauseCategory
    attention_level: AttentionLevel
    title: str = Field(..., description="Short catchphrase summary of the clause")
    section: str = Field(..., description="Section title or number in the document")
    evidence: str = Field(..., description="EXACT verbatim quote from the text supporting this finding, in the document's original language")
    explanation: str = Field(..., description="Simple, non-legal explanation of what this means for the user")


class HypocrisyAlert(BaseModel):
    detected: bool = False
    title: str = ""
    message: str = ""
    trackers: List[str] = Field(default_factory=list)


class SemanticChange(BaseModel):
    type: str
    text: str


class SemanticDiff(BaseModel):
    has_changed: bool = False
    previous_date: Optional[str] = None
    changes: List[SemanticChange] = Field(default_factory=list)


class ToSAnalysisResult(BaseModel):
    domain: str
    # Deterministic safety prediction (0-100). Higher = safer.
    # Computed by deterministic_safety_score() from text markers, LLM
    # findings, browser-detected trackers and cookie consent choices.
    safety_score: int = Field(0, ge=0, le=100, description="Safety prediction 0-100. Higher = safer.")
    # Human-readable label derived from safety_score (e.g. "Mostly safe").
    safety_prediction: str = Field("Unknown", description="Label for the safety prediction, e.g. 'Very safe' or 'High risk'.")
    summary: str = Field(..., description="2-3 sentence overview of the terms")
    findings: List[Finding]
    analysis_available: bool = True
    analysis_error: Optional[str] = None
    analysis_source: str = "ai"
    declared_third_party_sharing: Optional[bool] = None
    detected_trackers: List[str] = Field(default_factory=list)
    hypocrisy_alert: Optional[HypocrisyAlert] = None
    privacy_email: Optional[str] = None
    can_opt_out: bool = False
    semantic_diff: Optional[SemanticDiff] = None
    cookie_breakdown: Optional[CookieBreakdown] = None


class AnalyzeRequest(BaseModel):
    url: str
    text: str
    detected_trackers: List[str] = Field(default_factory=list)
    consent_controls: List[dict] = Field(default_factory=list)
    language: str = "en"  # browser language code, e.g. "bg"


class AskRequest(BaseModel):
    url: str
    question: str
    context_text: str
    history: Optional[list[dict]] = None


class AskResponse(BaseModel):
    answer: str = Field(
        ...,
        description="Answer written in the same language as the user's question",
    )
    evidence_quote: Optional[str] = Field(
        None,
        description="Exact verbatim quote copied from the document in its original language, or null if the document does not address the question",
    )


class ClassifyRequest(BaseModel):
    text: str = Field(..., description="Extracted text to classify")


class ClassifyResponse(BaseModel):
    is_legal: bool = Field(..., description="Whether the text is a legal/consent document")
    error: Optional[str] = None


def safety_prediction_label(score: int) -> str:
    """
    Map a numeric safety score (0-100) to a human-readable prediction label.
    Higher score = safer.
    """
    if score >= 85:
        return "Very safe"
    if score >= 65:
        return "Mostly safe"
    if score >= 40:
        return "Use with caution"
    if score >= 20:
        return "Risky"
    return "High risk"