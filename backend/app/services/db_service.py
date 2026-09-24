from ..database import get_supabase
from ..schemas import ToSAnalysisResult
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

    async def save_analysis(self, url: str, domain: str, title: Optional[str], analysis_result: ToSAnalysisResult) -> Optional[str]:
        """
        Save the analysis result to Supabase and return the record ID.
        If RLS blocks writes, return None instead of crashing the endpoint.
        """
        try:
            data = {
                "url": url,
                "domain": domain,
                "title": title,
                "safety_score": analysis_result.safety_score,
                "summary": analysis_result.summary,
                "findings": analysis_result.findings.model_dump() if hasattr(analysis_result.findings, 'model_dump') else [f.model_dump() for f in analysis_result.findings],
            }
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
            raise Exception(f"Failed to save analysis to Supabase: {e}")

    async def get_recent_analyses(self, limit: int = 10) -> List[ToSAnalysisResult]:
        """
        Fetch recent analyses from Supabase for the history endpoint.
        """
        try:
            response = self.supabase.table('analyses').select('*').order('created_at', desc=True).limit(limit).execute()
            results = []
            for record in response.data:
                results.append(ToSAnalysisResult(
                    domain=record['domain'],
                    safety_score=record['safety_score'],
                    summary=record['summary'],
                    findings=record['findings']
                ))
            return results
        except Exception as e:
            print(f"Error fetching recent analyses: {e}")
            return []

    async def get_latest_tos_history(self, domain: str) -> Optional[dict]:
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