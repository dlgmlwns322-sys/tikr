const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 홈 화면 지수·환율·코인이 실시간으로 안 잡히던 문제 원인: 이 심볼들을 자동으로 갱신하는 크론이
// 아예 없었음(개별 미국주식 finnhub-quote만 1분 크론이 있었고, 나머지는 화면 진입 시에만 온디맨드 호출).
// 이 함수 하나가 지수(KOSPI/KOSDAQ)·국내개별종목·환율·코인을 순서대로(await로 직렬 호출) 갱신한다.
// KIS 호출(kis-index, kis-stock-quote)을 병렬이 아니라 순차로 호출해야 "초당 거래건수 초과" 에러를 피함.
async function call(path: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const body = await res.json().catch(() => ({}));
  return { path, ok: res.ok, body };
}

Deno.serve(async () => {
  const results = [];
  results.push(await call("kis-index"));
  results.push(await call("kis-stock-quote"));
  results.push(await call("forex-quote"));
  results.push(await call("upbit-quote"));
  results.push(await call("binance-quote"));
  return Response.json({ results });
});
