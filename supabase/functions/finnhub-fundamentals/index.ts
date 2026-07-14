const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 미국 개별종목 밸류에이션(PER/PBR/배당수익률/52주최고저/시가총액) — 온디맨드, DB 저장 없음(컨센서스와 동일 패턴).
// Finnhub Basic Financials(metric=all)는 무료 티어에서 접근 가능(실호출로 확인됨).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const { symbol } = await req.json().catch(() => ({}));
  if (!symbol) return Response.json({ error: "symbol 필요" }, { status: 400, headers: CORS_HEADERS });

  try {
    const url = new URL("https://finnhub.io/api/v1/stock/metric");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("metric", "all");
    url.searchParams.set("token", FINNHUB_API_KEY);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub metric 조회 실패 (${symbol}, ${res.status}): ${await res.text()}`);
    const body = await res.json();
    const m = body.metric ?? {};
    return Response.json({
      symbol,
      per: m.peBasicExclExtraTTM ?? null,
      pbr: m.pbAnnual ?? null,
      dividendYield: m.dividendYieldIndicatedAnnual ?? null,
      week52High: m["52WeekHigh"] ?? null,
      week52Low: m["52WeekLow"] ?? null,
      marketCapM: m.marketCapitalization ?? null, // 백만달러 단위
    }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500, headers: CORS_HEADERS });
  }
});
