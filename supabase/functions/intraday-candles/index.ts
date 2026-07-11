const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 캔들차트 1일/1주용 "장중(분·시간)봉" on-demand 조회. DB 저장 안 하고 매 요청마다 야후에서 바로 받아 반환.
// 토스처럼 1일=분봉, 1주=시간봉으로 캔들이 빽빽하게 나오게 하는 용도.
// 야후 파이낸스 차트 API는 미국뿐 아니라 한국 종목(000660.KS 등)도 분봉을 무인증으로 제공 —
// 그래서 KIS 분봉(당일만 됨) 대신 야후로 통일. 한국 1주도 61개(30분봉×5일)로 빽빽하게 나온다.
async function fetchYahooIntraday(symbol: string, period: string) {
  const interval = period === "1W" ? "30m" : "5m";
  const range = period === "1W" ? "5d" : "1d";
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
  url.searchParams.set("interval", interval);
  url.searchParams.set("range", range);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`yahoo ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const result = body.chart?.result?.[0];
  if (!result) throw new Error("yahoo: 데이터 없음");
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  return ts
    .map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i],
    }))
    .filter((r) => r.close != null && r.open != null);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const { symbol, period } = await req.json().catch(() => ({}));
  if (!symbol) return Response.json({ error: "symbol 필요" }, { status: 400, headers: CORS_HEADERS });
  try {
    const rows = await fetchYahooIntraday(symbol, period);
    // 야후가 못 주는 자산(지수·환율·코인 일부)은 일봉으로 폴백하라고 프론트에 신호
    if (!rows.length) return Response.json({ fallback: "daily" }, { headers: CORS_HEADERS });
    return Response.json({ rows, source: "yahoo" }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({ error: (e as Error).message, fallback: "daily" }, { status: 200, headers: CORS_HEADERS });
  }
});
