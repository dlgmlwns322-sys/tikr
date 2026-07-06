const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;

// 브라우저(웹앱)에서 직접 호출하므로 CORS 헤더 필수 — 없으면 curl/서버 테스트는 통과해도 브라우저에서 막힘
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol, days } = await req.json().catch(() => ({}));

  if (!symbol) {
    return Response.json({ error: "symbol is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const to = new Date();
  const from = new Date(to.getTime() - (days ?? 7) * 24 * 60 * 60 * 1000);

  const url = new URL("https://finnhub.io/api/v1/company-news");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("from", isoDate(from));
  url.searchParams.set("to", isoDate(to));
  url.searchParams.set("token", FINNHUB_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status, headers: CORS_HEADERS });
  }

  const body = await res.json();
  const items = (body ?? []).map((item: Record<string, unknown>) => ({
    headline: item.headline,
    summary: item.summary,
    source: item.source,
    url: item.url,
    datetime: new Date((item.datetime as number) * 1000).toISOString(),
  }));

  return Response.json({ items }, { headers: CORS_HEADERS });
});
