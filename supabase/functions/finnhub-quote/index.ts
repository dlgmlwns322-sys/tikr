import { createClient } from "jsr:@supabase/supabase-js@2";

const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface FinnhubQuote {
  c: number; // current price
  d: number; // change
  dp: number; // percent change
  h: number;
  l: number;
  o: number;
  pc: number; // previous close
  t: number;
}

async function fetchQuote(symbol: string): Promise<FinnhubQuote> {
  const res = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`,
  );
  if (!res.ok) {
    throw new Error(`Finnhub 시세 조회 실패 (${symbol}, ${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

// 미국 정규장(월~금 9:30~16:00 ET)만 열림. 장 마감·주말엔 시세가 안 변하므로
// Finnhub 호출·DB 조회를 아예 건너뛰어 egress(무료 5GB 한도)를 아낀다. 크론은 1분 그대로 돌되 함수가 조기 종료.
function usMarketOpen(): boolean {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const wd = p.find((x) => x.type === "weekday")?.value;
  if (wd === "Sat" || wd === "Sun") return false;
  const hh = +(p.find((x) => x.type === "hour")?.value ?? "0");
  const mm = +(p.find((x) => x.type === "minute")?.value ?? "0");
  const mins = hh * 60 + mm;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

Deno.serve(async () => {
  if (!usMarketOpen()) return Response.json({ skipped: "us market closed" });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: watchlist, error } = await supabase
    .from("watchlist")
    .select("symbol")
    .eq("market", "nasdaq");

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const symbols = (watchlist ?? []).map((w) => w.symbol);

  const quotes = await Promise.all(
    symbols.map(async (symbol) => ({ symbol, quote: await fetchQuote(symbol) })),
  );

  // 장 마감 중(주말·시간외)엔 Finnhub이 마지막 체결가를 그대로 반복 응답함.
  // 이걸 그대로 매분 다 저장하면 quote_history가 동일 가격 중복 row로 도배되어
  // (실제 있었던 며칠치 변동은 몇 개뿐인데 중복이 수백 개) 차트가 "평평한 선+끝에 튀는 점"처럼 보임.
  // 직전 저장값과 가격이 동일하면(=장 멈춤) 새 row를 안 쌓고 건너뛴다.
  const lastRows = await Promise.all(
    symbols.map(async (symbol) => {
      const { data } = await supabase
        .from("quote_history")
        .select("price")
        .eq("symbol", symbol)
        .order("fetched_at", { ascending: false })
        .limit(1);
      return { symbol, lastPrice: (data ?? [])[0]?.price };
    }),
  );
  const lastPriceBySymbol = Object.fromEntries(lastRows.map((r) => [r.symbol, r.lastPrice]));

  const now = new Date().toISOString();
  const inserts = quotes
    .filter(({ symbol, quote }) => lastPriceBySymbol[symbol] === undefined || lastPriceBySymbol[symbol] !== quote.c)
    .map(({ symbol, quote }) => ({
      symbol,
      price: quote.c,
      change: quote.d,
      percent_change: quote.dp,
      fetched_at: now,
    }));

  if (inserts.length > 0) {
    await supabase.from("quote_history").insert(inserts);
  }

  return Response.json({
    quotes: quotes.map(({ symbol, quote }) => ({ symbol, price: quote.c, change: quote.d, percent_change: quote.dp })),
    inserted: inserts.length,
  });
});
