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
  // 하위 함수 응답 body는 끝까지 읽어서(기존처럼 완료 대기) 버리고 요약만 반환 — body 통째로 싣던 응답이 egress로 잡혀서 줄임.
  await res.arrayBuffer().catch(() => {});
  return { path, ok: res.ok, status: res.status };
}

// 한국 정규장(월~금 9:00~15:30 KST)만 KIS(지수·개별종목) 갱신. 마감·주말엔 시세 안 변하니 건너뛰어 egress 절약.
// 환율은 항상 확인하되 동일 가격은 저장하지 않는다. 비트코인은 15분마다 갱신한다.
function krMarketOpen(): boolean {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const wd = p.find((x) => x.type === "weekday")?.value;
  if (wd === "Sat" || wd === "Sun") return false;
  const hh = +(p.find((x) => x.type === "hour")?.value ?? "0");
  const mm = +(p.find((x) => x.type === "minute")?.value ?? "0");
  const mins = hh * 60 + mm;
  return mins >= 9 * 60 && mins < 15 * 60 + 30;
}

Deno.serve(async () => {
  const results = [];
  if (krMarketOpen()) {
    results.push(await call("kis-index"));
    results.push(await call("kis-stock-quote"));
  }
  results.push(await call("forex-quote"));
  const minute = new Date().getUTCMinutes();
  if (minute % 15 === 0) results.push(await call("upbit-quote"));
  return Response.json({ results });
});
