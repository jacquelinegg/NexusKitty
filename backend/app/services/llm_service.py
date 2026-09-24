import asyncio
import json
import logging
import re
from typing import Optional

from openai import OpenAI

try:
    from google import genai
    from google.genai import types
except ImportError:
    genai = None
    types = None

from ..prompts import (
    TOS_ANALYSIS_SYSTEM_PROMPT,
    ASK_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    CLASSIFY_SYSTEM_PROMPT,
)
from ..schemas import (
    ToSAnalysisResult,
    AskResponse,
    ClassifyResponse,
    Finding,
    AttentionLevel,
    ClauseCategory,
)
from ..config import settings

logger = logging.getLogger(__name__)

# low | medium | high. Override with GROQ_REASONING_EFFORT in .env if the
# setting exists in config.py; otherwise "medium" is used.
GROQ_REASONING_EFFORT = getattr(settings, "GROQ_REASONING_EFFORT", None) or "medium"


class LLMService:
    def __init__(self):
        self.client = OpenAI(
            api_key=settings.GROQ_API_KEY,
            base_url="https://api.groq.com/openai/v1",
        )
        self.model = settings.GROQ_MODEL
        self.gemini_model = settings.GEMINI_MODEL
        self.gemini_client = (
            genai.Client(api_key=settings.GEMINI_API_KEY)
            if genai and settings.GEMINI_API_KEY
            else None
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _error_kind(self, error: Exception) -> str:
        """Classify a provider error so logs and users get the real reason."""
        message = str(error).lower()
        if (
            "429" in message
            or "rate limit" in message
            or "rate_limit" in message
            or "quota" in message
            or "insufficient_quota" in message
        ):
            return "rate_limit"
        if (
            "model_not_found" in message
            or "does not exist" in message
            or "do not have access" in message
        ):
            return "model_unavailable"
        return "other"

    def _local_quote(self, text: str, patterns: list[str]) -> str:
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                start = max(0, match.start() - 90)
                end = min(len(text), match.end() + 180)
                return text[start:end].strip()
        return ""

    def _ask_messages(self, context_text: str, question: str, history: list = None) -> list[dict]:
        messages = [
            {"role": "system", "content": f"{SYSTEM_PROMPT}\n\n{ASK_SYSTEM_PROMPT}"},
        ]

        # Inject document context as a system message
        context_msg = f"DOCUMENT CONTEXT:\n{context_text}\n---"
        messages.append({"role": "system", "content": context_msg})

        # Add chat history if provided
        if history:
            for msg in history:
                role = "user" if msg.get("sender") == "user" else "assistant"
                messages.append({"role": role, "content": msg.get("text", "")})

        messages.append({"role": "user", "content": question})
        return messages

    # ------------------------------------------------------------------
    # Groq (synchronous SDK calls; always run through asyncio.to_thread)
    # ------------------------------------------------------------------

    def _analyze_with_groq(self, text: str, language: str = "en") -> ToSAnalysisResult:
        extra = {"reasoning_effort": GROQ_REASONING_EFFORT}
        user_content = f"OUTPUT LANGUAGE: {language}\n\n{text}"

        # 1) Structured output (needs json_schema support on the model)
        try:
            completion = self.client.beta.chat.completions.parse(
                model=self.model,
                messages=[
                    {"role": "system", "content": TOS_ANALYSIS_SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                response_format=ToSAnalysisResult,
                extra_body=extra,
            )
            parsed = completion.choices[0].message.parsed
            if parsed:
                return self._finalize(parsed, "groq")
        except Exception as e:
            # Rate limits / missing model will fail again in JSON mode; give up now.
            if self._error_kind(e) != "other":
                raise
            logger.warning("Groq structured parse failed, trying JSON mode: %s", e)

        # 2) Plain JSON mode with the schema spelled out in the prompt
        schema = json.dumps(ToSAnalysisResult.model_json_schema())
        completion = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        TOS_ANALYSIS_SYSTEM_PROMPT
                        + "\n\nReturn ONLY a JSON object that matches this JSON schema:\n"
                        + schema
                    ),
                },
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            extra_body=extra,
        )
        result = ToSAnalysisResult.model_validate_json(completion.choices[0].message.content)
        return self._finalize(result, "groq")

    def _answer_with_groq(self, context_text: str, question: str, history: list = None) -> AskResponse:
        messages = self._ask_messages(context_text, question, history)
        extra = {"reasoning_effort": GROQ_REASONING_EFFORT}

        # 1) Structured output
        try:
            completion = self.client.beta.chat.completions.parse(
                model=self.model,
                messages=messages,
                response_format=AskResponse,
                temperature=0,
                extra_body=extra,
            )
            parsed = completion.choices[0].message.parsed
            if parsed:
                return parsed
        except Exception as e:
            if self._error_kind(e) != "other":
                raise
            logger.warning("Groq structured parse failed, trying JSON mode: %s", e)

        # 2) Plain JSON mode
        completion = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0,
            extra_body=extra,
        )
        return AskResponse.model_validate_json(completion.choices[0].message.content)

    # ------------------------------------------------------------------
    # Gemini (synchronous SDK calls; always run through asyncio.to_thread)
    # ------------------------------------------------------------------

    def _analyze_with_gemini(self, text: str, language: str = "en") -> Optional[ToSAnalysisResult]:
        if not self.gemini_client or not types:
            return None
        try:
            response = self.gemini_client.models.generate_content(
                model=self.gemini_model,
                contents=f"OUTPUT LANGUAGE: {language}\n\n{text}",
                config=types.GenerateContentConfig(
                    system_instruction=TOS_ANALYSIS_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    response_schema=ToSAnalysisResult,
                    temperature=0,
                ),
            )
            result = ToSAnalysisResult.model_validate_json(response.text)
            return self._finalize(result, "gemini")
        except Exception:
            logger.exception("Gemini analysis failed")
            return None

    def _answer_with_gemini(self, context_text: str, question: str, history: list = None) -> Optional[AskResponse]:
        if not self.gemini_client or not types:
            return None
        try:
            messages = self._ask_messages(context_text, question, history)
            contents_text = "\n".join(f"[{m['role']}] {m['content']}" for m in messages)
            response = self.gemini_client.models.generate_content(
                model=self.gemini_model,
                contents=contents_text,
                config=types.GenerateContentConfig(
                    system_instruction=f"{SYSTEM_PROMPT}\n\n{ASK_SYSTEM_PROMPT}",
                    response_mime_type="application/json",
                    response_schema=AskResponse,
                    temperature=0,
                ),
            )
            return AskResponse.model_validate_json(response.text)
        except Exception:
            logger.exception("Gemini answer failed")
            return None

    def _finalize(self, result: ToSAnalysisResult, source: str) -> ToSAnalysisResult:
        """The server, not the model, decides whether the provider worked."""
        return result.model_copy(update={
            "analysis_source": source,
            "analysis_available": True,
            "analysis_error": None,
        })

    # ------------------------------------------------------------------
    # Local fallbacks
    # ------------------------------------------------------------------

    def _fallback_analysis(self, text: str, reason: str = "providers_unavailable") -> ToSAnalysisResult:
        """Provide a transparent, evidence-based scan when the AI providers are unavailable."""
        source = text or ""
        findings: list[Finding] = []

        checks = [
            (
                ClauseCategory.PRIVACY,
                AttentionLevel.HIGH,
                "Personal data collection",
                [r"personal data", r"IP address", r"unique identifiers", r"geolocation"],
                "The document describes collecting information that can identify or profile visitors.",
            ),
            (
                ClauseCategory.PRIVACY,
                AttentionLevel.HIGH,
                "Sharing with third parties or advertisers",
                [r"advertising partners", r"third[- ]party", r"third parties", r"share.{0,50}(data|information)"],
                "The document allows data or browsing information to be shared beyond the site operator.",
            ),
            (
                ClauseCategory.PRIVACY,
                AttentionLevel.MEDIUM,
                "Tracking and analytics",
                [r"tracking", r"analytics", r"measure.{0,30}traffic", r"personalized advertising"],
                "Tracking or measurement technologies may be used to understand activity or target content.",
            ),
            (
                ClauseCategory.PRIVACY,
                AttentionLevel.MEDIUM,
                "Consent and cookie controls",
                [r"consent", r"accept all cookies", r"manage cookies", r"cookie preferences"],
                "The notice describes consent or preference controls, but the exact choices should be reviewed.",
            ),
            (
                ClauseCategory.MONEY,
                AttentionLevel.HIGH,
                "Automatic billing or renewal",
                [r"automatically renew", r"automatic renewal", r"recurring", r"subscription"],
                "The document may allow recurring charges or automatic renewal of a paid service.",
            ),
            (
                ClauseCategory.MONEY,
                AttentionLevel.MEDIUM,
                "Refund restrictions",
                [r"no refunds?", r"non-refundable", r"refund policy", r"refunds?"],
                "Refund eligibility or limits may reduce your ability to recover a payment.",
            ),
            (
                ClauseCategory.TERMINATION,
                AttentionLevel.MEDIUM,
                "Account termination rights",
                [r"terminate", r"suspend", r"delete your account"],
                "The operator may reserve broad rights to suspend or end access.",
            ),
            (
                ClauseCategory.USER_CONTENT,
                AttentionLevel.MEDIUM,
                "Rights to user content",
                [r"user content", r"royalty[- ]free license", r"perpetual license", r"intellectual property"],
                "The document may grant the operator rights to use content submitted by users.",
            ),
            (
                ClauseCategory.AI_USAGE,
                AttentionLevel.HIGH,
                "AI training or automated processing",
                [r"train.{0,40}(model|AI)", r"artificial intelligence", r"machine learning"],
                "The document may permit automated processing or use of user material in AI systems.",
            ),
        ]

        for category, attention, title, patterns, explanation in checks:
            evidence = self._local_quote(source, patterns)
            if evidence:
                findings.append(
                    Finding(
                        category=category,
                        attention_level=attention,
                        title=title,
                        section="Local document scan",
                        evidence=evidence,
                        explanation=explanation,
                    )
                )

        score = max(
            20,
            100 - sum(18 if item.attention_level == AttentionLevel.HIGH else 9 for item in findings),
        )
        if not findings:
            summary = (
                "The AI providers are unavailable and the local scan found no supported risk signals "
                "in the supplied text. This is not a legal judgment."
            )
        else:
            summary = (
                f"Local scan found {len(findings)} supported signal(s) in the document. "
                "This result uses exact text matches because the AI providers are temporarily "
                "unavailable (rate limit or outage) and is not a legal opinion."
            )

        return ToSAnalysisResult(
            domain="unknown",
            safety_score=score,
            summary=summary,
            findings=findings,
            analysis_available=True,
            analysis_error=reason,
            analysis_source="local_fallback",
            cookie_breakdown=None,
        )

    def _detect_language(self, text: str) -> str:
        """Detect language using Unicode script ranges + langdetect for Latin script."""
        if re.search(r'[\u3040-\u30FF\u309B-\u30FC]', text):
            return 'ja'
        if re.search(r'[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7FF]', text):
            return 'ko'
        if re.search(r'[\u4E00-\u9FFF\u3400-\u4DBF]', text):
            return 'zh'
        if re.search(r'[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFEFF]', text):
            return 'ar'
        if re.search(r'[\u0590-\u05FF]', text):
            return 'he'
        if re.search(r'[\u0370-\u03FF]', text):
            return 'el'
        if re.search(r'[\u0900-\u097F]', text):
            return 'hi'
        if re.search(r'[\u0E00-\u0E7F]', text):
            return 'th'
        if re.search(r'[\u0400-\u04FF]', text):
            if re.search(r'[іїєґ]', text):
                return 'uk'
            if re.search(r'[ыэё]', text):
                return 'ru'
            return 'bg'
        try:
            from langdetect import detect
            return detect(text)
        except Exception:
            return 'en'

    _FALLBACK_NO_DOCS = {
        'bg': 'Този документ не предвижда информация относно тази тема.',
        'ru': 'Этот документ не содержит информации по данной теме.',
        'uk': 'Цей документ не містить інформації щодо цієї теми.',
        'ja': 'このドキュメントは、このトピックに関する情報を指定していません。',
        'de': 'Dieses Dokument enthält keine Informationen zu diesem Thema.',
        'fr': 'Ce document ne spécifie aucune information à propos de ce sujet.',
        'es': 'Este documento no especifica información sobre este tema.',
        'it': 'Questo documento non specifica informazioni su questo argomento.',
        'pt': 'Este documento não especifica informações sobre este tópico.',
        'nl': 'Dit document vermeldt geen informatie over dit onderwerp.',
        'pl': 'Ten dokument nie zawiera informacji na temat tej tematyki.',
        'cs': 'Tento dokument neobsahuje informace týkající se tohoto tématu.',
        'hu': 'Ez a dokumentum nem tartalmaz információt erről a témáról.',
        'ro': 'Acest document nu specifică informații despre acest subiect.',
        'tr': 'Bu belge bu konu hakkında bilgi belirtmez.',
        'el': 'Το έγγραφο δεν περιέχει πληροφορίες σχετικά με αυτό το θέμα.',
        'ar': 'هذا المستند لا يحدد أي معلومات حول هذا الموضوع.',
        'zh': '本文档未指定有关此主题的信息。',
        'ko': '이 문서는 이 주제에 관한 정보를 지정하지 않습니다.',
        'hi': 'यह दस्तावेज़ इस विषय के बारे में कोई जानकारी नहीं देता है।',
        'th': 'เอกสารนี้ไม่ระบุข้อมูลเกี่ยวกับหัวข้อนี้',
        'he': 'המסמך לא מציין מידע לגבי נושא זה',
        'en': 'This document does not specify information regarding this topic.',
    }

    _FALLBACK_LLM_DOWN = {
        'bg': 'В момента не мога да получа отговор от ИИ доставчика. Опитайте отново скоро.',
        'ru': 'В данный момент я не могу получить ответ от ИИ-провайдера. Попробуйте позже.',
        'uk': 'В даний момент я не можу отримати відповідь від постачальника ШІ. Спробуйте пізніше.',
        'ja': '現在、AIプロバイダーから回答を取得できません。暫くしてからもう一度お試しください。',
        'de': 'Ich konnte gerade keine Antwort vom KI-Anbieter erhalten. Bitte versuchen Sie es später erneut.',
        'fr': "Je n'ai pas pu obtenir de réponse du fournisseur d'IA pour le moment. Veuillez réessayer plus tard.",
        'es': 'No he podido obtener una respuesta del proveedor de IA en este momento. Por favor, inténtalo de nuevo más tarde.',
        'it': "Non sono riuscito ad ottenere una risposta dal provider di intelligenza artificiale in questo momento. Per favore, riprova più tardi.",
        'pt': 'Não consegui obter uma resposta do provedor de IA neste momento. Por favor, tente novamente mais tarde.',
        'nl': 'Ik kon momenteel geen antwoord krijgen van de AI-leverancier. Probeer het later opnieuw.',
        'pl': 'W tej chwili nie mogę uzyskać odpowiedzi od dostawcy AI. Spróbuj ponownie później.',
        'cs': 'V tuto chvíli nemohu získat odpověď od poskytovatele AI. Zkuste to znovu později.',
        'hu': 'Jelenleg nem tudok választ kapni az AI szolgáltatótól. Próbálja meg később.',
        'ro': 'În acest moment nu pot obține un răspuns de la furnizorul de IA. Vă rugăm să încercați din nou mai târziu.',
        'tr': 'Şu anda yapay zekâ sağlayıcıdan yanıt alamıyorum. Lütfen daha sonra tekrar deneyin.',
        'el': 'Δεν μπόρησα να λάβω απάντηση από τον πάροχο τεχνητής νοημοσύνης αυτήν τη στιγμή. Παρακαλώ προσπαθήστε ξανά αργότερα.',
        'ar': 'لا أستطيع الحصول على إجابة من مزود الذكاء الاصطناعي في الوقت الحالي. يرجى المحاولة مرة أخرى لاحقًا.',
        'zh': '暂时无法从 AI 提供商处获取答案。请稍后重试。',
        'ko': '지금 AI 공급자로부터 답변을 얻을 수 없습니다. 나중에 다시 시도하십시오.',
        'hi': 'मैं अभी AI प्रदादक से उत्तर नहीं पा रहा हूँ। कृपया बाद में पुनःप्रयास करें।',
        'th': 'ฉันยังไม่สามารถได้รับคำตอบจากผู้ให้บริการปัญญาประดิษฐ์ในขณะนี้ กรุณาลองอีกครั้งในภายหลัง',
        'he': 'לא הצלחתי לקבל תשובה מספק הבינה מלאכותית כעת. אנא נסה שוב מאוחר יותר',
        'en': "I couldn't get an answer from the AI provider right now. Please try again in a moment.",
    }

    def _fallback_answer(self, context_text: str, question: str) -> AskResponse:
        lang = self._detect_language(question)
        fallbacks = self._FALLBACK_NO_DOCS if not context_text else self._FALLBACK_LLM_DOWN
        answer = fallbacks.get(lang, fallbacks['en'])
        return AskResponse(answer=answer, evidence_quote=None)

    # ------------------------------------------------------------------
    # Public async API  (order: Groq -> Gemini -> local fallback)
    # ------------------------------------------------------------------

    async def analyze_tos(self, text: str, language: str = "en") -> ToSAnalysisResult:
        reason = "providers_unavailable"

        try:
            return await asyncio.to_thread(self._analyze_with_groq, text, language)
        except Exception as e:
            reason = self._error_kind(e)
            logger.warning("Groq analysis failed (%s): %s", reason, str(e)[:500])

        gemini_result = await asyncio.to_thread(self._analyze_with_gemini, text, language)
        if gemini_result:
            return gemini_result

        return self._fallback_analysis(text, reason)

    async def ask_question(self, context_text: str, question: str, history: list = None) -> AskResponse:
        """Groq first, then Gemini, then a safe fallback. Never raises."""
        try:
            return await asyncio.to_thread(
                self._answer_with_groq, context_text, question, history
            )
        except Exception as e:
            logger.warning(
                "Groq answer failed (%s): %s", self._error_kind(e), str(e)[:500]
            )

        gemini_answer = await asyncio.to_thread(
            self._answer_with_gemini, context_text, question, history
        )
        if gemini_answer:
            return gemini_answer

        return self._fallback_answer(context_text, question)

    # ------------------------------------------------------------------
    # Classify: is this text a legal/consent document?
    # ------------------------------------------------------------------

    def _classify_with_groq(self, text: str) -> Optional[bool]:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": CLASSIFY_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            response_format={"type": "json_object"},
        )
        result = json.loads(response.choices[0].message.content)
        return result.get("is_legal")

    def _classify_with_gemini(self, text: str) -> Optional[bool]:
        if not self.gemini_client or not types:
            return None
        try:
            response = self.gemini_client.models.generate_content(
                model=self.gemini_model,
                contents=text,
                config=types.GenerateContentConfig(
                    system_instruction=CLASSIFY_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    response_schema={
                        "type": "object",
                        "properties": {
                            "is_legal": {"type": "boolean"}
                        },
                        "required": ["is_legal"],
                    },
                    temperature=0,
                ),
            )
            result = json.loads(response.text)
            return result.get("is_legal")
        except Exception:
            logger.exception("Gemini classify failed")
            return None

    async def classify_text(self, text: str) -> ClassifyResponse:
        """Classify whether text is a legal/consent document (Groq → Gemini → conservative fallback)."""
        error = None
        try:
            result = await asyncio.to_thread(self._classify_with_groq, text)
            if result is not None:
                return ClassifyResponse(is_legal=result)
        except Exception as e:
            error = self._error_kind(e)
            logger.warning("Groq classify failed (%s): %s", error, str(e)[:500])

        gemini_result = await asyncio.to_thread(self._classify_with_gemini, text)
        if gemini_result is not None:
            return ClassifyResponse(is_legal=gemini_result)

        # Conservative fallback: assume legal so we don't hide consent text
        return ClassifyResponse(is_legal=True, error=error or "providers_unavailable")