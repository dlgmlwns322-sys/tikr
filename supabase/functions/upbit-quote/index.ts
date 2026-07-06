import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 업비트 공개 API는 인증 없이 시세 조회 가능
const MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP"];

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
