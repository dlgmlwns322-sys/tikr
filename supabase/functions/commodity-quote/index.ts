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

function isoCompact(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 금 백필: GoldAPI 무료 티어는 날짜별 조회(1콜=1일치)라 월 100회 한도 안에서 안전하게 최근 N일(최대 30일)만 채운다.
// 유가 백필: OilPriceAPI는 past_year/past_month가 1콜로 구간 전체를 반환해서 한도 걱정 없이 넉넉히 받아온다.
async function backfillGold(days: number) {
  const safeDays = Math.min(days, 30);
  const today = new Date();
  const inserts = [];
  for (let i = safeDays; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const res = await fetch(`https://www.goldapi.io/api/XAU/USD/${isoCompact(d)}`, {
      headers: { "x-access-token": GOLDAPI_KEY },
    });
    if (res.ok) {
      const body = await res.json();
      if (body.price) {
        inserts.push({ symbol: "XAUUSD", price: body.price, date: isoCompact(d) });
      }
    }
    if (i > 0) await sleep(300);
  }
  const withChange = [];
  for (let i = 0; i < inserts.length; i++) {
    const prev = i > 0 ? inserts[i - 1].price : null;
    const change = prev != null ? inserts[i].price - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    const d = inserts[i].date;
    const isoDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T18:00:00.000Z`;
    withChange.push({ symbol: "XAUUSD", price: inserts[i].price, change, percent_change: percentChange, fetched_at: isoDate });
  }
  return withChange;
}

async function backfillOil() {
  const res = await fetch("https://api.oilpriceapi.com/v1/prices/past_year", {
    headers: { Authorization: `Token ${OILPRICEAPI_KEY}` },
  });
  if (!res.ok) return [];
  const body = await res.json();
  const rows = (body.data?.prices ?? body.prices ?? []) as any[];
  const sorted = rows.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const withChange = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = parseFloat(sorted[i].price);
    const prev = i > 0 ? parseFloat(sorted[i - 1].price) : null;
    const change = prev != null ? cur - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    withChange.push({ symbol: "BRENT_CRUDE", price: cur, change, percent_change: percentChange, fetched_at: sorted[i].created_at });
  }
  return withChange;
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { days } = await req.json().catch(() => ({}));

  if (days) {
    const [goldRows, oilRows] = await Promise.all([backfillGold(days), backfillOil()]);
    const inserts = [...goldRows, ...oilRows];
    // 재백필 시 중복 방지 (정확한 타임스탬프만 지우고 다시 채움)
    for (const symbol of ["XAUUSD", "BRENT_CRUDE"]) {
      const timestamps = inserts.filter((r) => r.symbol === symbol).map((r) => r.fetched_at);
      if (timestamps.length) await supabase.from("quote_history").delete().eq("symbol", symbol).in("fetched_at", timestamps);
    }
    if (inserts.length) await supabase.from("quote_history").insert(inserts);
    return Response.json({ inserted: inserts.length, gold: goldRows.length, oil: oilRows.length });
  }

  const [gold, oil] = await Promise.all([fetchGold(), fetchOil()]);
  const results = [gold, oil];

  await supabase.from("quote_history").insert(results);

  return Response.json({ quotes: results });
});
