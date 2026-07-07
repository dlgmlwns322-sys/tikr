import { createClient } from "jsr:@supabase/supabase-js@2";

const GOLDAPI_KEY = Deno.env.get("GOLDAPI_KEY")!;
const OILPRICEAPI_KEY = Deno.env.get("OILPRICEAPI_KEY")!;
const ALPHAVANTAGE_API_KEY = Deno.env.get("ALPHAVANTAGE_API_KEY")!;
const FRED_API_KEY = Deno.env.get("FRED_API_KEY")!;
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

// 금 백필: Alpha Vantage GOLD_SILVER_HISTORY가 1콜로 2011년부터의 일별 시세 전체를 반환함(무료, 하루 25회 한도 중 1회만 씀).
// GoldAPI(날짜별 1콜=1일)로 하루씩 긁던 이전 방식보다 훨씬 낫고 한도 걱정도 없음.
async function backfillGold(days: number) {
  const res = await fetch(
    `https://www.alphavantage.co/query?function=GOLD_SILVER_HISTORY&symbol=XAU&interval=daily&apikey=${ALPHAVANTAGE_API_KEY}`,
  );
  if (!res.ok) return [];
  const body = await res.json();
  const rows = (body.data ?? []) as { date: string; price: string }[];
  if (!rows.length) return [];
  // API는 최신순(desc)으로 옴 -> 과거→최신으로 뒤집고 요청한 days만큼만 최근 구간 사용
  const sorted = rows.slice().reverse().slice(-days);
  const withChange = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = parseFloat(sorted[i].price);
    const prev = i > 0 ? parseFloat(sorted[i - 1].price) : null;
    const change = prev != null ? cur - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    withChange.push({ symbol: "XAUUSD", price: cur, change, percent_change: percentChange, fetched_at: `${sorted[i].date}T18:00:00.000Z` });
  }
  return withChange;
}

// 유가 백필: FRED(DCOILBRENTEU, 브렌트유, 1987년부터)가 완전 무료·무제한에 가까운 한도라 OilPriceAPI(월 200회, past_year도
// 실제론 한 달치만 줌)보다 훨씬 깊은 히스토리를 1콜로 받을 수 있음. 이미 bond-us에서 쓰는 FRED_API_KEY 재사용.
async function backfillOil(days: number) {
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", "DCOILBRENTEU");
  url.searchParams.set("api_key", FRED_API_KEY);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", String(Math.min(days + 50, 5000))); // 휴장일 여유분 포함
  const res = await fetch(url);
  if (!res.ok) return [];
  const body = await res.json();
  const valid = (body.observations ?? []).filter((o: any) => o.value !== ".");
  if (!valid.length) return [];
  const sorted = valid.slice().reverse().slice(-days); // 과거→최신, 요청한 days만큼만
  const withChange = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = parseFloat(sorted[i].value);
    const prev = i > 0 ? parseFloat(sorted[i - 1].value) : null;
    const change = prev != null ? cur - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    withChange.push({ symbol: "BRENT_CRUDE", price: cur, change, percent_change: percentChange, fetched_at: `${sorted[i].date}T21:00:00.000Z` });
  }
  return withChange;
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { days } = await req.json().catch(() => ({}));

  if (days) {
    const [goldRows, oilRows] = await Promise.all([backfillGold(days), backfillOil(days)]);
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
