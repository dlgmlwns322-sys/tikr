import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 업비트 공개 API는 인증 없이 시세 조회 가능
const MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP"];

// 코인 백필: 업비트 공개 캔들 API(/v1/candles/days)로 일별 종가 히스토리를 무료·무인증으로 받는다.
// 1회 최대 200개라 365일 채우려면 to(커서) 파라미터로 페이지네이션.
async function backfillMarket(market: string, symbol: string, days: number) {
  const candles: any[] = [];
  let to: string | undefined = undefined;
  while (candles.length < days) {
    const url = new URL("https://api.upbit.com/v1/candles/days");
    url.searchParams.set("market", market);
    url.searchParams.set("count", String(Math.min(200, days - candles.length)));
    if (to) url.searchParams.set("to", to);
    const res = await fetch(url);
    if (!res.ok) break;
    const chunk = await res.json();
    if (!chunk.length) break;
    candles.push(...chunk);
    to = chunk[chunk.length - 1].candle_date_time_utc; // 다음 페이지는 이 시점 이전(exclusive)부터
    if (chunk.length < 200) break; // 더 받을 데이터 없음
  }
  const sorted = candles.sort(
    (a, b) => new Date(a.candle_date_time_utc).getTime() - new Date(b.candle_date_time_utc).getTime(),
  );
  const trimmed = sorted.slice(-days);
  const inserts = [];
  for (let i = 0; i < trimmed.length; i++) {
    const cur = trimmed[i].trade_price;
    const prev = i > 0 ? trimmed[i - 1].trade_price : null;
    const change = prev != null ? cur - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    inserts.push({ symbol, price: cur, change, percent_change: percentChange, fetched_at: `${trimmed[i].candle_date_time_utc}.000Z` });
  }
  return inserts;
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { days } = await req.json().catch(() => ({}));

  if (days) {
    const perMarket = await Promise.all(
      MARKETS.map((m) => backfillMarket(m, m.replace("KRW-", "") + "_KRW", days)),
    );
    const inserts = perMarket.flat();
    for (const symbol of MARKETS.map((m) => m.replace("KRW-", "") + "_KRW")) {
      const timestamps = inserts.filter((r) => r.symbol === symbol).map((r) => r.fetched_at);
      if (timestamps.length) await supabase.from("quote_history").delete().eq("symbol", symbol).in("fetched_at", timestamps);
    }
    if (inserts.length) await supabase.from("quote_history").insert(inserts);
    return Response.json({ inserted: inserts.length, perMarket: perMarket.map((r) => r.length) });
  }

  const res = await fetch(`https://api.upbit.com/v1/ticker?markets=${MARKETS.join(",")}`);
  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status });
  }
  const body = await res.json();

  const quotes = body.map((t: any) => ({
    symbol: t.market.replace("KRW-", "") + "_KRW",
    price: t.trade_price,
    change: t.signed_change_price,
    percent_change: t.signed_change_rate * 100,
    fetched_at: new Date(t.trade_timestamp).toISOString(),
  }));

  if (quotes.length > 0) {
    await supabase.from("quote_history").insert(quotes);
  }

  return Response.json({ quotes });
});
