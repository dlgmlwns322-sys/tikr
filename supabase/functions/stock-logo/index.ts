const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 미국종목 로고 2차 폴백 — 프론트가 1차로 쓰는 토스증권 정적 리소스(비공식)에 없는 티커(예: GEV)를 위해
// Finnhub 공식 API(company profile)에서 로고 URL을 받아온다. 한국종목은 Finnhub도 프리미엄 전용(403)이라 대상 아님.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const { symbol } = await req.json().catch(() => ({}));
  if (!symbol) return Response.json({ error: "symbol 필요" }, { status: 400, headers: CORS_HEADERS });

  try {
    const url = new URL("https://finnhub.io/api/v1/stock/profile2");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("token", FINNHUB_API_KEY);
    const res = await fetch(url);
    if (!res.ok) return Response.json({ logo: null }, { headers: CORS_HEADERS });
    const body = await res.json();
    return Response.json({ logo: body.logo || null }, { headers: CORS_HEADERS });
  } catch (_e) {
    return Response.json({ logo: null }, { headers: CORS_HEADERS });
  }
});
