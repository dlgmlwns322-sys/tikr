import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// tikr-analyst 서브에이전트(Claude Code)가 심층 리서치한 결과를 stock_summaries에 적재하는 전용 엔드포인트.
// 프론트(loadSummary/loadMacroSummary)는 이 테이블 최신 row를 그대로 읽으므로, 여기 쓰는 것만으로
// 앱의 "AI 종합 요약" 카드가 자동으로 갱신됨(앱 코드 변경 불필요). service_role 키는 여기서만 쓰고
// 서브에이전트에는 절대 노출 안 함 — 서브에이전트는 이 함수를 anon key로만 호출.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol, summary, sources } = await req.json().catch(() => ({}));
  if (!symbol || !summary) {
    return Response.json({ error: "symbol, summary 필요" }, { status: 400, headers: CORS_HEADERS });
  }
  if (typeof summary !== "string" || summary.length > 4000) {
    return Response.json({ error: "summary는 4000자 이하 문자열이어야 함" }, { status: 400, headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase.from("stock_summaries").insert({
    symbol,
    summary,
    sources: sources ?? {},
    model: "claude-tikr-analyst",
  });

  if (error) return Response.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });
  return Response.json({ ok: true, symbol }, { headers: CORS_HEADERS });
});
