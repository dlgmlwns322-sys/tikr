const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;

// 브라우저(웹앱)에서 직접 호출하므로 CORS 헤더 필수 — 없으면 curl/서버 테스트는 통과해도 브라우저에서 막힘
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Finnhub search는 영문 글로벌 티커 위주라 한글 종목명(예: "하이닉스")은 못 찾음.
// 코스피/코스닥 주요 종목은 자체 사전으로 보완 (별칭 포함, 부분일치).
// symbol은 6자리 코드+.KS(코스피)/.KQ(코스닥) 형식.
const KR_STOCKS: { symbol: string; name: string; aliases: string[] }[] = [
  { symbol: "005930.KS", name: "삼성전자", aliases: ["삼전"] },
  { symbol: "000660.KS", name: "SK하이닉스", aliases: ["하이닉스", "SK하이닉스"] },
  { symbol: "373220.KS", name: "LG에너지솔루션", aliases: ["엘지에너지솔루션", "LG엔솔"] },
  { symbol: "207940.KS", name: "삼성바이오로직스", aliases: ["삼바"] },
  { symbol: "005380.KS", name: "현대차", aliases: ["현대자동차"] },
  { symbol: "000270.KS", name: "기아", aliases: [] },
  { symbol: "035420.KS", name: "NAVER", aliases: ["네이버"] },
  { symbol: "035720.KS", name: "카카오", aliases: [] },
  { symbol: "068270.KS", name: "셀트리온", aliases: [] },
  { symbol: "005490.KS", name: "POSCO홀딩스", aliases: ["포스코"] },
  { symbol: "051910.KS", name: "LG화학", aliases: ["엘지화학"] },
  { symbol: "006400.KS", name: "삼성SDI", aliases: ["삼성에스디아이"] },
  { symbol: "105560.KS", name: "KB금융", aliases: ["케이비금융"] },
  { symbol: "055550.KS", name: "신한지주", aliases: [] },
  { symbol: "012330.KS", name: "현대모비스", aliases: [] },
  { symbol: "028260.KS", name: "삼성물산", aliases: [] },
  { symbol: "066570.KS", name: "LG전자", aliases: ["엘지전자"] },
  { symbol: "003670.KS", name: "포스코퓨처엠", aliases: [] },
  { symbol: "247540.KQ", name: "에코프로비엠", aliases: [] },
  { symbol: "086520.KQ", name: "에코프로", aliases: [] },
  { symbol: "196170.KQ", name: "알테오젠", aliases: [] },
  { symbol: "091990.KQ", name: "셀트리온헬스케어", aliases: [] },
];

function searchKrStocks(query: string) {
  const q = query.trim();
  return KR_STOCKS.filter((s) => s.name.includes(q) || s.aliases.some((a) => a.includes(q) || q.includes(a)))
    .map((s) => ({ symbol: s.symbol, name: s.name }));
}

// 미국 주요 종목의 한글 이름 별칭 사전 (Finnhub search는 영문만 지원해서 "애플" 검색이 안 됨)
const US_STOCKS_KR: { symbol: string; name: string; aliases: string[] }[] = [
  { symbol: "AAPL", name: "Apple Inc.", aliases: ["애플"] },
  { symbol: "NVDA", name: "NVIDIA Corp.", aliases: ["엔비디아"] },
  { symbol: "TSLA", name: "Tesla Inc.", aliases: ["테슬라"] },
  { symbol: "MSFT", name: "Microsoft Corp.", aliases: ["마이크로소프트"] },
  { symbol: "GOOGL", name: "Alphabet Inc.", aliases: ["구글", "알파벳"] },
  { symbol: "AMZN", name: "Amazon.com", aliases: ["아마존"] },
  { symbol: "META", name: "Meta Platforms", aliases: ["메타", "페이스북"] },
  { symbol: "AMD", name: "AMD Inc.", aliases: ["에이엠디"] },
  { symbol: "NFLX", name: "Netflix Inc.", aliases: ["넷플릭스"] },
  { symbol: "QQQ", name: "Invesco QQQ Trust", aliases: ["나스닥100", "큐큐큐"] },
  { symbol: "INTC", name: "Intel Corp.", aliases: ["인텔"] },
  { symbol: "QCOM", name: "Qualcomm Inc.", aliases: ["퀄컴"] },
  { symbol: "AVGO", name: "Broadcom Inc.", aliases: ["브로드컴"] },
  { symbol: "ORCL", name: "Oracle Corp.", aliases: ["오라클"] },
  { symbol: "CRM", name: "Salesforce Inc.", aliases: ["세일즈포스"] },
  { symbol: "ADBE", name: "Adobe Inc.", aliases: ["어도비"] },
  { symbol: "PYPL", name: "PayPal Holdings", aliases: ["페이팔"] },
  { symbol: "UBER", name: "Uber Technologies", aliases: ["우버"] },
  { symbol: "DIS", name: "Walt Disney Co.", aliases: ["디즈니"] },
  { symbol: "KO", name: "Coca-Cola Co.", aliases: ["코카콜라"] },
  { symbol: "PEP", name: "PepsiCo Inc.", aliases: ["펩시"] },
  { symbol: "MCD", name: "McDonald's Corp.", aliases: ["맥도날드"] },
  { symbol: "SBUX", name: "Starbucks Corp.", aliases: ["스타벅스"] },
  { symbol: "NKE", name: "Nike Inc.", aliases: ["나이키"] },
  { symbol: "WMT", name: "Walmart Inc.", aliases: ["월마트"] },
  { symbol: "COST", name: "Costco Wholesale", aliases: ["코스트코"] },
  { symbol: "JPM", name: "JPMorgan Chase", aliases: ["제이피모건", "JP모건"] },
  { symbol: "BAC", name: "Bank of America", aliases: ["뱅크오브아메리카"] },
  { symbol: "V", name: "Visa Inc.", aliases: ["비자"] },
  { symbol: "MA", name: "Mastercard Inc.", aliases: ["마스터카드"] },
  { symbol: "BA", name: "Boeing Co.", aliases: ["보잉"] },
  { symbol: "PFE", name: "Pfizer Inc.", aliases: ["화이자"] },
  { symbol: "JNJ", name: "Johnson & Johnson", aliases: ["존슨앤존슨"] },
  { symbol: "XOM", name: "Exxon Mobil", aliases: ["엑슨모빌"] },
  { symbol: "SPY", name: "SPDR S&P 500 ETF", aliases: ["S&P500", "에스앤피500", "스파이"] },
  { symbol: "COIN", name: "Coinbase Global", aliases: ["코인베이스"] },
  { symbol: "PLTR", name: "Palantir Technologies", aliases: ["팔란티어"] },
  { symbol: "SOFI", name: "SoFi Technologies", aliases: ["소파이"] },
  { symbol: "RIVN", name: "Rivian Automotive", aliases: ["리비안"] },
];

function searchUsStocksKr(query: string) {
  const q = query.trim();
  return US_STOCKS_KR.filter((s) => s.aliases.some((a) => a.includes(q) || q.includes(a)))
    .map((s) => ({ symbol: s.symbol, name: s.name }));
}

// 회사명/티커로 심볼 검색. market: "kr"=코스피/코스닥 자체사전만, "us"=미국(한글별칭+Finnhub)만, 없으면 둘 다
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { query, market } = await req.json().catch(() => ({}));
  if (!query) {
    return Response.json({ error: "query is required" }, { status: 400, headers: CORS_HEADERS });
  }

  if (market === "kr") {
    return Response.json({ items: searchKrStocks(query).slice(0, 10) }, { headers: CORS_HEADERS });
  }

  const krAliasItems = market === "us" ? [] : searchKrStocks(query);
  const usAliasItems = searchUsStocksKr(query);

  const url = new URL("https://finnhub.io/api/v1/search");
  url.searchParams.set("q", query);
  url.searchParams.set("token", FINNHUB_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status, headers: CORS_HEADERS });
  }

  const body = await res.json();
  const finnhubItems = (body.result ?? [])
    .filter((r: Record<string, unknown>) => r.type === "Common Stock")
    .slice(0, 10)
    .map((r: Record<string, unknown>) => ({ symbol: r.symbol, name: r.description }));

  // 한글 별칭으로 이미 찾은 종목은 Finnhub 결과에서 중복 제거
  const aliasSymbols = new Set(usAliasItems.map((i) => i.symbol));
  const dedupedFinnhub = finnhubItems.filter((i: { symbol: string }) => !aliasSymbols.has(i.symbol));

  const items = market === "us"
    ? [...usAliasItems, ...dedupedFinnhub]
    : [...krAliasItems, ...usAliasItems, ...dedupedFinnhub];

  return Response.json({ items: items.slice(0, 10) }, { headers: CORS_HEADERS });
});
