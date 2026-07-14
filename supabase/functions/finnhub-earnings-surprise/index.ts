const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 미국 개별종목 실적 서프라이즈(실제 EPS vs 컨센서스 예상치) — 온디맨드, DB 저장 없음.
// finnhub-earnings(캘린더/발표일정)와는 별개 — 이건 발표된 실제 결과치.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const { symbol } = await req.json().catch(() => ({}));
  if (!symbol) return Response.json({ error: "symbol 필요" }, { status: 400, headers: CORS_HEADERS });

  try {
    const url = new URL("https://finnhub.io/api/v1/stock/earnings");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("token", FINNHUB_API_KEY);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`실적 서프라이즈 조회 실패 (${symbol}, ${res.status}): ${await res.text()}`);
    const body = await res.json();
    const surprises = (Array.isArray(body) ? body : []).slice(0, 4).map((e: Record<string, unknown>) => ({
      period: e.period,
      actual: e.actual,
      estimate: e.estimate,
      surprisePercent: e.surprisePercent,
    }));
    return Response.json({ symbol, surprises }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500, headers: CORS_HEADERS });
  }
});
