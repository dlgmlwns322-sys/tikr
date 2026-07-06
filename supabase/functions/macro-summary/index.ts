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

// 개별 종목이 아닌 지수·환율·채권·코인 같은 매크로 자산용 추이 코멘트.
// 뉴스·애널리스트 데이터가 없으므로 시세 흐름만 근거로 하고, 확정적 매수/매도 지시가 아니라
// 추세·변동성 해석 중심으로 서술하도록 프롬프트에서 명시(투자 조언 아님을 항상 명시).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol, label } = await req.json().catch(() => ({}));

  if (!symbol) {
    return Response.json({ error: "symbol is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: quotes, error } = await supabase
    .from("quote_history")
    .select("price, change, percent_change, fetched_at")
    .eq("symbol", symbol)
    .order("fetched_at", { ascending: false })
    .limit(60);

  if (error) {
    return Response.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });
  }
  if (!quotes || quotes.length < 2) {
    return Response.json({ error: "추세를 분석하기엔 데이터가 부족해요 (최소 2개 시점 필요)" }, { status: 404, headers: CORS_HEADERS });
  }

  const displayName = label || symbol;

  const prompt = `너는 개인 투자자를 위한 시장 데이터 분석 비서다. 아래는 "${displayName}"의 최근 시세 이력(최신순)이다. 이 숫자 흐름만 근거로 한국어 3~4문장으로 서술해라.

규칙:
- 데이터에 없는 뉴스·이벤트·원인을 지어내지 마라. 오직 가격·등락률 추이만 근거로 한다
- 최근 추세(상승/하락/횡보), 변동성(변동폭이 큰지 잔잔한지), 최근 며칠간의 방향성 변화 여부를 서술
- 마지막 문장은 "관심 강도"를 완곡하게 표현하되(예: "단기 상승 모멘텀이 이어지는 편", "변동성이 커져 주의가 필요해 보임" 등), "사세요/파세요/매수하세요/매도하세요" 같은 직접적 매매 지시는 절대 하지 말 것
- 반드시 "이 코멘트는 투자 조언이 아니며 참고용입니다"로 끝맺을 것
- 마크다운 기호 쓰지 말 것

[최근 시세 이력 (최신순, 최대 60개)]
${JSON.stringify(quotes, null, 2)}`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
      }),
    },
  );

  if (!geminiRes.ok) {
    return Response.json({ error: "gemini", detail: await geminiRes.text() }, { status: geminiRes.status, headers: CORS_HEADERS });
  }

  const geminiBody = await geminiRes.json();
  const summary: string = geminiBody.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  const sources = {
    latest_quote: quotes[0],
    oldest_quote_in_window: quotes[quotes.length - 1],
    points_used: quotes.length,
  };

  await supabase.from("stock_summaries").insert({
    symbol,
    summary,
    sources,
    model: GEMINI_MODEL,
  });

  return Response.json({ symbol, summary, sources }, { headers: CORS_HEADERS });
});
