const NAVER_CLIENT_ID = Deno.env.get("NAVER_CLIENT_ID")!;
const NAVER_CLIENT_SECRET = Deno.env.get("NAVER_CLIENT_SECRET")!;

// 브라우저(웹앱)에서 직접 호출하므로 CORS 헤더 필수 — 없으면 curl/서버 테스트는 통과해도 브라우저에서 막힘
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function stripTags(text: string): string {
  return text.replace(/<\/?b>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { query, display } = await req.json().catch(() => ({}));

  if (!query) {
    return Response.json({ error: "query is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const url = new URL("https://openapi.naver.com/v1/search/news.json");
  url.searchParams.set("query", query);
  url.searchParams.set("display", String(display ?? 10));
  url.searchParams.set("sort", "date");

  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
    },
  });

  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status, headers: CORS_HEADERS });
  }

  const body = await res.json();
  const items = (body.items ?? []).map((item: Record<string, string>) => ({
    title: stripTags(item.title),
    description: stripTags(item.description),
    link: item.originallink || item.link,
    pubDate: item.pubDate,
  }));

  return Response.json({ items }, { headers: CORS_HEADERS });
});
