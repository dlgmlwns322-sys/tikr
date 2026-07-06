import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 바이낸스 공개 시장데이터 API는 인증 없이 조회 가능
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "XRPUSDT"];

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const results = await Promise.all(
    SYMBOLS.map(async (sym) => {
      const res = await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${sym}`);
      if (!res.ok) throw new Error(`바이낸스 조회 실패 (${sym}, ${res.status}): ${await res.text()}`);
      const t = await res.json();
      return {
        symbol: sym.replace("USDT", "") + "_USDT",
        price: parseFloat(t.lastPrice),
        change: parseFloat(t.priceChange),
        percent_change: parseFloat(t.priceChangePercent),
        fetched_at: new Date(t.closeTime).toISOString(),
      };
    }),
  );

  await supabase.from("quote_history").insert(results);

  return Response.json({ quotes: results });
});
