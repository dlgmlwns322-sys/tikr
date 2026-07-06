const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;

// 브라우저(웹앱)에서 직접 호출하므로 CORS 헤더 필수 — 없으면 curl/서버 테스트는 통과해도 브라우저에서 막힘
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol } = await req.json().catch(() => ({}));

  if (!symbol) {
    return Response.json({ error: "symbol is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const recRes = await fetch(
    `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${FINNHUB_API_KEY}`,
  );

  if (!recRes.ok) {
    return Response.json({ error: "recommendation", detail: await recRes.text() }, { status: recRes.status, headers: CORS_HEADERS });
  }

  const recommendations = await recRes.json();

  // price-target 엔드포인트는 Finnhub 유료 플랜 전용이라 무료 티어에서는 항상 null
  return Response.json({
    symbol,
    latest_recommendation: recommendations?.[0] ?? null,
    price_target: null,
  }, { headers: CORS_HEADERS });
});
