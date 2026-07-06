import { createClient } from "jsr:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GEMINI_MODEL = "gemini-2.5-flash";

// 브라우저(웹앱)에서 직접 호출하므로 CORS 헤더 필수 — 없으면 curl/서버 테스트는 통과해도 브라우저에서 막힘
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function callFunction(name: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${name} 호출 실패 (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

interface QuoteRow {
  price: number;
  change: number | null;
  percent_change: number | null;
  fetched_at: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol, korean_query } = await req.json().catch(() => ({}));

  if (!symbol) {
    return Response.json({ error: "symbol is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: quotes, error: quoteError } = await supabase
    .from("quote_history")
    .select("price, change, percent_change, fetched_at")
    .eq("symbol", symbol)
    .order("fetched_at", { ascending: false })
    .limit(5);

  if (quoteError) {
    return Response.json({ error: quoteError.message }, { status: 500, headers: CORS_HEADERS });
  }

  // 후보군은 넉넉히 모으고(국내 15건, 해외 10건), 실제로 사용자에게 보여줄 건 Gemini가
  // 가격 변동과 관련성 높은 국내기사 최대 3건만 골라내게 한다(해외기사는 사용자가 못 읽으므로
  // 화면에 노출하지 않고 요약 생성 참고자료로만 사용).
  const [enNews, analyst, earnings, krNews] = await Promise.all([
    callFunction("finnhub-news", { symbol, days: 5 }).catch(() => ({ items: [] })),
    callFunction("finnhub-analyst", { symbol }).catch(() => ({ latest_recommendation: null, price_target: null })),
    callFunction("finnhub-earnings").catch(() => ({ events: [] })),
    korean_query ? callFunction("naver-news", { query: korean_query, display: 15 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
  ]);

  const earningsForSymbol = (earnings.events ?? []).filter((e: { symbol: string }) => e.symbol === symbol);

  const latestQuote: QuoteRow | undefined = (quotes ?? [])[0];

  const prompt = `너는 개인 투자자를 위한 주식 분석 비서다. 아래 데이터만 근거로, 추측 없이 "${symbol}" 종목을 분석해라.

[요약 작성 규칙]
- 데이터에 없는 내용은 절대 지어내지 마라.
- 가격 변동이 있으면 수치(변동폭·변동률)를 인용하고, 뉴스에 언급된 원인이 있으면 연결해서 설명해라(국내·해외 뉴스 후보 모두 참고 가능).
- 뉴스에 원인이 없으면 "뉴스에서 뚜렷한 원인은 확인되지 않음"이라고 명시해라.
- 애널리스트 컨센서스·실적발표 예정일이 있으면 마지막에 짧게 덧붙여라.
- 3~5문장, 마크다운 기호 쓰지 말 것.

[뉴스 선별 규칙 — 중요]
- "국내 뉴스 후보" 목록 중에서, 이 종목의 가격 변동과 실제로 관련 있는 기사만 최대 3개 골라 top_news에 넣어라(관련성 낮은 노이즈 기사는 제외).
- top_news는 국내 뉴스 후보 중에서만 골라라 (해외 뉴스는 요약 작성에는 참고하되 top_news에는 절대 넣지 마라 — 사용자가 영어를 못 읽는다).
- 관련성 높은 국내기사가 3개 미만이면 있는 만큼만 넣고, 하나도 없으면 빈 배열로 둬라.

[최근 시세 이력 (최신순, 최대 5개)]
${JSON.stringify(quotes ?? [], null, 2)}

[해외 뉴스 후보 (Finnhub, 최근 5일, 요약 참고용 — 사용자에게 노출 안 함)]
${JSON.stringify(enNews.items ?? [], null, 2)}

[국내 뉴스 후보 (네이버, 최근순)]
${JSON.stringify((krNews.items ?? []).map((n: any, i: number) => ({ idx: i, title: n.title, description: n.description, link: n.link, pubDate: n.pubDate })), null, 2)}

[애널리스트 컨센서스]
${JSON.stringify(analyst, null, 2)}

[향후 90일 내 실적발표 일정]
${JSON.stringify(earningsForSymbol, null, 2)}`;

  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      top_news: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            link: { type: "string" },
          },
          required: ["title", "link"],
        },
      },
    },
    required: ["summary", "top_news"],
  };

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          responseSchema: schema,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );

  if (!geminiRes.ok) {
    return Response.json({ error: "gemini", detail: await geminiRes.text() }, { status: geminiRes.status, headers: CORS_HEADERS });
  }

  const geminiBody = await geminiRes.json();
  const raw = geminiBody.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  let parsed: { summary?: string; top_news?: { title: string; link: string }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { summary: raw, top_news: [] };
  }

  const summary = parsed.summary ?? "";
  const topNews = parsed.top_news ?? [];

  const sources = {
    latest_quote: latestQuote ?? null,
    en_news_count: (enNews.items ?? []).length,
    kr_news_candidates: (krNews.items ?? []).length,
    top_news: topNews,
    analyst_recommendation: analyst.latest_recommendation ?? null,
    upcoming_earnings: earningsForSymbol,
  };

  await supabase.from("stock_summaries").insert({
    symbol,
    summary,
    sources,
    model: GEMINI_MODEL,
  });

  return Response.json({ symbol, summary, top_news: topNews, sources }, { headers: CORS_HEADERS });
});
