from ..database import get_supabase
from ..schemas import ToSAnalysisResult, safety_prediction_label
from typing import List, Optional
import hashlib

class DBService:
    def __init__(self):
        self.supabase = get_supabase()

    def _hash_url(self, url: str) -> str:
        return hashlib.sha256(url.encode()).hexdigest()

    async def get_analysis_by_url(self, url: str) -> Optional[ToSAnalysisResult]:
        """
        Check if we have a cached analysis for the given URL.
        """
        try:
            response = self.supabase.table('analyses').select('*').eq('url', url).execute()
            if response.data and len(response.data) > 0:
                # Convert the Supabase record to ToSAnalysisResult
                record = response.data[0]
                return ToSAnalysisResult(
                    url=record.get('url'),
                    domain=record['domain'],
                    safety_score=record['safety_score'],
                    summary=record['summary'],
                    findings=record['findings']  # Assuming findings is stored as JSONB and returned as list
                )
            return None
        except Exception as e:
            # Log the error and return None (cache miss)
            print(f"Error fetching analysis from Supabase: {e}")
            return None

    async def get_analysis_by_url_and_hash(self, url: str, content_hash: str) -> Optional[ToSAnalysisResult]:
        """
        Check if we have a cached analysis for the given URL AND content hash.

        This lookup is intentionally NOT scoped by client_id: it only reuses
        the LLM's prior read of this exact document text (same ToS text ->
        same findings), never anyone's personal browsing history, so sharing
        it across installations just saves LLM calls.

        A record with a missing/null content_hash is treated as a cache
        miss so that old records created before content-hash deduplication
        existed do not block re-analysis of new content.
        """
        try:
            response = (
                self.supabase
                .table('analyses')
                .select('*')
                .eq('url', url)
                .eq('content_hash', content_hash)
                .execute()
            )
            if response.data and len(response.data) > 0:
                record = response.data[0]
                return ToSAnalysisResult(
                    url=record.get('url'),
                    domain=record['domain'],
                    safety_score=record['safety_score'],
                    summary=record['summary'],
                    findings=record['findings']
                )
            return None
        except Exception as e:
            print(f"Error fetching analysis by URL+hash from Supabase: {e}")
            return None

    async def analysis_exists_for_hash(
        self,
        url: str,
        content_hash: str,
        client_id: Optional[str] = None,
    ) -> bool:
        """
        Check whether an analysis for this URL + content_hash already exists
        FOR THIS CLIENT. Used to prevent duplicate history records when the
        same page content is re-analyzed (e.g. after iframe consent relay).

        IMPORTANT: this must be scoped by client_id. If it weren't, a second
        installation visiting a URL someone else already scanned would be
        told "already exists" and would never get its own history row -
        it would just silently piggyback on (and never see) the first
        installation's entry.
        """
        try:
            query = (
                self.supabase
                .table('analyses')
                .select('id')
                .eq('url', url)
                .eq('content_hash', content_hash)
            )
            if client_id:
                query = query.eq('client_id', client_id)
            response = query.limit(1).execute()
            return bool(response.data and len(response.data) > 0)
        except Exception as e:
            print(f"Error checking content hash dedup: {e}")
            return False

    async def touch_analysis_recency(
        self,
        url: str,
        client_id: Optional[str] = None,
    ) -> bool:
        """
        Bump this client's existing row for `url` to "now" (created_at)
        without inserting a new row, so a revisit of unchanged content
        still jumps back to the top of THIS CLIENT's history.

        Scoped by client_id so bumping one installation's row can never
        touch, or be triggered by, another installation's history.
        """
        try:
            from datetime import datetime, timezone
            query = (
                self.supabase
                .table('analyses')
                .update({"created_at": datetime.now(timezone.utc).isoformat()})
                .eq('url', url)
            )
            if client_id:
                query = query.eq('client_id', client_id)
            response = query.execute()
            return bool(response.data)
        except Exception as e:
            print(f"Error touching analysis recency for {url}: {e}")
            return False

    async def get_analysis_by_domain(self, domain: str) -> Optional[ToSAnalysisResult]:
        """
        Check if we have a cached analysis for the given domain (if URL not found).
        """
        try:
            response = self.supabase.table('analyses').select('*').eq('domain', domain).execute()
            if response.data and len(response.data) > 0:
                # We'll return the most recent one
                record = response.data[0]  # Assuming we order by created_at desc? We'll do that in the query.
                return ToSAnalysisResult(
                    domain=record['domain'],
                    safety_score=record['safety_score'],
                    summary=record['summary'],
                    findings=record['findings']
                )
            return None
        except Exception as e:
            print(f"Error fetching analysis from Supabase: {e}")
            return None

    async def save_analysis(
        self,
        url: str,
        domain: str,
        title: Optional[str],
        analysis_result: ToSAnalysisResult,
        content_hash: Optional[str] = None,
        client_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        Save the analysis result to Supabase and return the record ID.
        If RLS blocks writes, return None instead of crashing the endpoint.

        client_id tags the row with the installation that produced it, so
        /api/history can filter to "this installation's scans only" instead
        of leaking every installation's browsing into one shared list.
        """
        data = {
            "url": url,
            "domain": domain,
            "title": title,
            "safety_score": analysis_result.safety_score,
            "summary": analysis_result.summary,
            "findings": analysis_result.findings.model_dump() if hasattr(analysis_result.findings, 'model_dump') else [f.model_dump() for f in analysis_result.findings],
        }
        if content_hash:
            data["content_hash"] = content_hash
        if client_id:
            data["client_id"] = client_id
        prediction = getattr(analysis_result, "safety_prediction", None)
        if prediction:
            data["safety_prediction"] = prediction

        for attempt in range(2):
            try:
                response = self.supabase.table('analyses').insert(data).execute()
                if response.data and len(response.data) > 0:
                    return response.data[0]['id']
                else:
                    raise Exception("Failed to save analysis: no data returned")
            except Exception as e:
                message = str(e).lower()
                if "row-level security" in message or "42501" in message or "rls" in message:
                    print(f"Supabase write denied by RLS; proceeding without cache save: {e}")
                    return None
                if "could not find the" in message and "column" in message and "safety_prediction" in message and attempt == 0:
                    # Schema cache stale - retry without safety_prediction
                    print(f"Schema cache stale, retrying without safety_prediction: {e}")
                    data.pop("safety_prediction", None)
                    continue
                if "could not find the" in message and "column" in message and "client_id" in message and attempt == 0:
                    # client_id column not migrated in yet - retry without it
                    # rather than crashing every analyze request.
                    print(f"Schema missing client_id column, retrying without it: {e}")
                    data.pop("client_id", None)
                    continue
                raise Exception(f"Failed to save analysis to Supabase: {e}")

    async def get_recent_analyses(
        self,
        limit: int = 10,
        client_id: Optional[str] = None,
    ) -> List[ToSAnalysisResult]:
        """
        Fetch recent analyses from Supabase for the history endpoint,
        SCOPED TO client_id when provided.

        Without the client_id filter this returns the most recent rows
        across every installation that has ever hit this backend - which
        was the source of the History tab leak (one profile seeing another
        profile's scanned sites).
        """
        try:
            query = self.supabase.table('analyses').select('*').order('created_at', desc=True)
            if client_id:
                query = query.eq('client_id', client_id)
            response = query.limit(limit).execute()
            results = []
            for record in response.data:
                results.append(ToSAnalysisResult(
                    url=record.get('url'),
                    domain=record['domain'],
                    safety_score=record.get('safety_score', 0),
                    safety_prediction=record.get('safety_prediction') or safety_prediction_label(record.get('safety_score', 0)),
                    summary=record['summary'],
                    findings=record['findings']
                ))
            return results
        except Exception as e:
            print(f"Error fetching recent analyses: {e}")
            return []

    async def get_recent_row_for_client_url(
        self,
        url: str,
        client_id: Optional[str] = None,
        minutes: int = 10,
    ) -> Optional[dict]:
        """
        Return this client's most recent row for `url` if it was created
        within the last `minutes` minutes, regardless of content_hash.

        This exists because content extraction can vary slightly between
        two back-to-back page opens (timing/partial DOM capture), which
        produces a different content_hash for what is really the same
        visit - and previously created a confusing duplicate history
        entry instead of being recognized as a re-open of the same page.
        """
        try:
            from datetime import datetime, timezone, timedelta
            query = (
                self.supabase.table('analyses')
                .select('id, created_at, content_hash')
                .eq('url', url)
            )
            if client_id:
                query = query.eq('client_id', client_id)
            response = query.order('created_at', desc=True).limit(1).execute()
            if not response.data:
                return None
            row = response.data[0]
            created_at = row.get('created_at')
            if not created_at:
                return None
            created_dt = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
            if datetime.now(timezone.utc) - created_dt <= timedelta(minutes=minutes):
                return row
            return None
        except Exception as e:
            print(f"Error checking recent row for {url}: {e}")
            return None

    async def update_analysis(
        self,
        row_id: str,
        analysis_result: ToSAnalysisResult,
        content_hash: Optional[str] = None,
    ) -> bool:
        """
        Overwrite an existing analyses row in place (same id) and refresh
        created_at, instead of inserting a new row. Used to collapse a
        near-duplicate re-analysis (same page, opened moments apart, but
        a slightly different content_hash due to extraction timing) into
        the single existing history entry rather than piling up copies.
        """
        try:
            from datetime import datetime, timezone
            data = {
                "safety_score": analysis_result.safety_score,
                "summary": analysis_result.summary,
                "findings": analysis_result.findings.model_dump() if hasattr(analysis_result.findings, 'model_dump') else [f.model_dump() for f in analysis_result.findings],
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            if content_hash:
                data["content_hash"] = content_hash
            prediction = getattr(analysis_result, "safety_prediction", None)
            if prediction:
                data["safety_prediction"] = prediction
            response = self.supabase.table('analyses').update(data).eq('id', row_id).execute()
            return bool(response.data)
        except Exception as e:
            print(f"Error updating analysis row {row_id}: {e}")
            return False

    async def get_latest_tos_history(self, domain: str) -> Optional[dict]:
        """
        Global by domain on purpose: this powers the Time Machine diff
        against the same public ToS document, not personal browsing data,
        so it's fine (and desirable) for it to be shared across clients.
        """
        try:
            response = (
                self.supabase.table("tos_history")
                .select("*")
                .eq("domain", domain)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            return response.data[0] if response.data else None
        except Exception as e:
            print(f"Error fetching ToS history: {e}")
            return None

    async def save_tos_history(
        self,
        domain: str,
        hash_sha256: str,
        raw_text: str,
        analysis_result: ToSAnalysisResult,
    ) -> Optional[str]:
        try:
            response = self.supabase.table("tos_history").insert({
                "domain": domain,
                "hash_sha256": hash_sha256,
                "raw_text": raw_text,
                "analysis_json": analysis_result.model_dump(mode="json"),
            }).execute()
            return response.data[0]["id"] if response.data else None
        except Exception as e:
            message = str(e).lower()
            if (
                ("relation" in message and "does not exist" in message)
                or "pgrst205" in message
                or "could not find the table" in message
                or "schema cache" in message
            ):
                print("ToS history table is not installed; continuing without time machine persistence")
                return None
            if "row-level security" in message or "42501" in message or "rls" in message:
                print(f"ToS history write denied by RLS; continuing without persistence: {e}")
                return None
            raise