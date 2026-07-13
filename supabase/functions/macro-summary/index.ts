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
  if (!res.ok) throw new Error(`${name} 호출 실패 (${res.status}): ${await res.text()}`);
  return await res.json();
}

interface QuoteRow {
  price: number;
  change: number | null;
  percent_change: number | null;
  fetched_at: string;
}

// 개별 종목이 아닌 지수·환율·원자재·코인·채권 같은 매크로 자산용 추이+뉴스 코멘트.
// 확정적 매수/매도 지시가 아니라 추세·변동성 해석 중심으로 서술하도록 프롬프트에서 명시(투자 조언 아님을 항상 명시).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol, label } = await req.json().catch(() => ({}));

  if (!symbol) {
    return Response.json({ error: "symbol is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 개별종목 stock-summary와 동일한 문제: 5분 간격 폴링이라 "최신 N개"만 보면 전부 오늘 하루 안의
  // 값이라 며칠짜리 흐름을 못 본다 → 넉넉히 가져온 뒤 날짜별 마지막 값만 남겨 일별 추이로 압축.
  const { data: rawQuotes, error } = await supabase
    .from("quote_history")
    .select("price, change, percent_change, fetched_at")
    .eq("symbol", symbol)
    .order("fetched_at", { ascending: false })
    .limit(300);

  if (error) {
    return Response.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });
  }
  if (!rawQuotes || rawQuotes.length < 2) {
    return Response.json({ error: "추세를 분석하기엔 데이터가 부족해요 (최소 2개 시점 필요)" }, { status: 404, headers: CORS_HEADERS });
  }

  const byDate = new Map<string, QuoteRow>();
  for (const q of rawQuotes) {
    const d = (q.fetched_at as string).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, q as QuoteRow);
  }
  const dailyQuotes = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-10)
    .map(([date, q]) => ({ date, price: q.price, change: q.change, percent_change: q.percent_change }));

  const latestQuote = rawQuotes[0];
  const oldest = dailyQuotes[0];
  const newest = dailyQuotes[dailyQuotes.length - 1];
  const periodChangePct = oldest && newest && oldest.price
    ? Math.round(((newest.price - oldest.price) / oldest.price) * 10000) / 100
    : null;

  const displayName = label || symbol;

  // 지수·환율·원자재·코인·채권도 실제로는 뉴스로 설명 가능한 원인이 있는 경우가 많음(예: 반도체 업황 뉴스가
  // 코스피를 움직이는 식) → label을 검색어로 국내 뉴스 후보를 모아 원인 후보로 함께 제공.
  const krNews = await callFunction("naver-news", { query: displayName, display: 20 }).catch(() => ({ items: [] }));

  const prompt = `너는 개인 투자자를 위한 시장 데이터 분석 비서다. 아래 데이터만 근거로, 추측 없이 "${displayName}"을 분석해라.

[핵심 원칙 — 반드시 지킬 것]
- 사용자는 이미 화면 차트·숫자로 등락 방향과 폭을 보고 있다. "올랐다/떨어졌다"는 사실만 되풀이하는 요약은 가치가 없다. **왜 그렇게 움직였는지 원인을 설명하는 게 이 요약의 존재 이유다.**
- 아래 [최근 일별 종가 추이]를 보고 의미 있는 변동(하루 급변 또는 기간 누적 변동 ±2% 이상)이 보이면, 아래 "국내 뉴스 후보"를 뒤져서 원인이 될 만한 사실을 최대한 찾아 연결해라.
- 원인이 여러 개 확인되면 하나로 뭉뚱그리지 말고 각각 따로 설명해라.
- 뉴스에서 뚜렷한 원인을 정말 못 찾았으면 "뉴스에서 뚜렷한 원인은 확인되지 않음"이라고 명확히 말하되, 그래도 시세 흐름 자체에서 확인되는 정황(추세 방향, 변동성 확대/축소 등)은 함께 적어라.
- 데이터에 없는 뉴스·이벤트·원인을 지어내지 마라.
- 마지막 문장은 "관심 강도"를 완곡하게 표현하되(예: "단기 상승 모멘텀이 이어지는 편", "변동성이 커져 주의가 필요해 보임" 등), "사세요/파세요/매수하세요/매도하세요" 같은 직접적 매매 지시는 절대 하지 말 것
- 반드시 "이 코멘트는 투자 조언이 아니며 참고용입니다"로 끝맺을 것
- 분량은 원인의 개수에 맞춰라 — 원인이 여러 개면 문장을 늘려서(대략 4~7문장) 전부 설명하고, 원인이 하나거나 없으면 짧게 끝내도 된다. 마크다운 기호 쓰지 말 것.

[뉴스 선별 규칙]
- "국내 뉴스 후보" 중에서, 이 자산의 가격 변동과 실제로 관련 있는 기사만 최대 6개 골라 top_news에 넣어라(관련성 낮은 노이즈 기사는 제외).
- 관련성 높은 기사가 6개 미만이면 있는 만큼만 넣고, 하나도 없으면 빈 배열로 둬라.

[최근 일별 종가 추이 (오래된순, 날짜당 그날 마지막 값)]
${JSON.stringify(dailyQuotes, null, 2)}
${periodChangePct !== null ? `→ 위 기간(${oldest.date}~${newest.date}) 누적 변동률: ${periodChangePct}%` : ""}

[가장 최근 시세 원본 (현재가·직전 변동)]
${JSON.stringify(latestQuote, null, 2)}

[국내 뉴스 후보 (네이버, 최근순)]
${JSON.stringify((krNews.items ?? []).map((n: any, i: number) => ({ idx: i, title: n.title, description: n.description, link: n.link, pubDate: n.pubDate })), null, 2)}`;

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
          // 뉴스 6건까지 근거로 종합 추론시키면서 thinking 토큰도 같은 예산을 나눠 쓰다 보니
          // 4096으론 가끔 답변이 잘려 JSON이 깨졌었음(finishReason=MAX_TOKENS) → 여유 있게 상향
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: schema,
          // 여러 뉴스를 시세 흐름과 엮어 원인을 종합해야 해서 thinkingBudget 0(즉답)은 너무 얕음 —
          // 기본 동적 사고 예산을 쓰도록 thinkingConfig 자체를 생략(모델이 필요한 만큼 추론)
        },
      }),
    },
  );

  if (!geminiRes.ok) {
    return Response.json({ error: "gemini", detail: await geminiRes.text() }, { status: geminiRes.status, headers: CORS_HEADERS });
  }

  const geminiBody = await geminiRes.json();
  const finishReason = geminiBody.candidates?.[0]?.finishReason;
  const raw = geminiBody.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  let parsed: { summary?: string; top_news?: { title: string; link: string }[] } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  // 응답이 잘려서(MAX_TOKENS) JSON을 못 닫으면 raw가 깨진 텍스트 그대로 남는데, 이걸 그대로
  // summary에 흘려보내면 사용자에게 JSON 잔해가 그대로 노출된다 — 이럴 땐 원문을 흘려보내지 말고
  // 에러로 처리해서 사용자가 재시도하게 한다.
  if (!parsed) {
    return Response.json(
      { error: "gemini_incomplete", detail: `finishReason=${finishReason}, 응답이 완성되지 못했어요. 다시 시도해주세요.` },
      { status: 502, headers: CORS_HEADERS },
    );
  }

  const summary = parsed.summary ?? "";
  const topNews = parsed.top_news ?? [];

  const sources = {
    latest_quote: latestQuote,
    oldest_quote_in_window: dailyQuotes[0] ?? null,
    points_used: dailyQuotes.length,
    kr_news_candidates: (krNews.items ?? []).length,
    top_news: topNews,
  };

  await supabase.from("stock_summaries").insert({
    symbol,
    summary,
    sources,
    model: GEMINI_MODEL,
  });

  return Response.json({ symbol, summary, top_news: topNews, sources }, { headers: CORS_HEADERS });
});
