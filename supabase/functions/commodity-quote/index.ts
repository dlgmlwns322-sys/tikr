import { createClient } from "jsr:@supabase/supabase-js@2";

const GOLDAPI_KEY = Deno.env.get("GOLDAPI_KEY")!;
const OILPRICEAPI_KEY = Deno.env.get("OILPRICEAPI_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Quote {
  symbol: string;
  price: number;
  change: number | null;
  percent_change: number | null;
  fetched_at: string;
}

async function fetchGold(): Promise<Quote> {
  const res = await fetch("https://www.goldapi.io/api/XAU/USD", {
    headers: { "x-access-token": GOLDAPI_KEY },
  });
  if (!res.ok) {
    throw new Error(`GoldAPI 조회 실패 (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  return {
    symbol: "XAUUSD",
    price: body.price,
    change: body.ch ?? null,
    percent_change: body.chp ?? null,
    fetched_at: new Date((body.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
  };
}

async function fetchOil(): Promise<Quote> {
  const res = await fetch("https://api.oilpriceapi.com/v1/prices/latest", {
    headers: { Authorization: `Token ${OILPRICEAPI_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`OilPriceAPI 조회 실패 (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  const data = body.data ?? body;
  return {
    symbol: "BRENT_CRUDE",
    price: data.price,
    change: null,
    percent_change: null,
    fetched_at: data.created_at ?? new Date().toISOString(),
  };
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const [gold, oil] = await Promise.all([fetchGold(), fetchOil()]);
  const results = [gold, oil];

  await supabase.from("quote_history").insert(results);

  return Response.json({ quotes: results });
});
