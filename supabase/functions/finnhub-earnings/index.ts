import { createClient } from "jsr:@supabase/supabase-js@2";

const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 브라우저(웹앱)에서 직접 호출하므로 CORS 헤더 필수 — 없으면 curl/서버 테스트는 통과해도 브라우저에서 막힘
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: watchlist, error } = await supabase
    .from("watchlist")
    .select("symbol")
    .eq("market", "nasdaq");

  if (error) {
    return Response.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });
  }

  const symbols = new Set((watchlist ?? []).map((w) => w.symbol));

  async function fetchEarnings(from: Date, to: Date) {
    const url = new URL("https://finnhub.io/api/v1/calendar/earnings");
    url.searchParams.set("from", isoDate(from));
    url.searchParams.set("to", isoDate(to));
    url.searchParams.set("token", FINNHUB_API_KEY);
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    return (body.earningsCalendar ?? []).filter((e: { symbol: string }) => symbols.has(e.symbol));
  }

  const today = new Date();
  const future90 = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
  const past120 = new Date(today.getTime() - 120 * 24 * 60 * 60 * 1000);

  try {
    const [futureEvents, pastEvents] = await Promise.all([
      fetchEarnings(today, future90),
      fetchEarnings(past120, today),
    ]);

    // 심볼별 가장 최근 과거 실적발표일만 남김
    const lastPastBySymbol: Record<string, any> = {};
    for (const e of pastEvents) {
      if (!lastPastBySymbol[e.symbol] || e.date > lastPastBySymbol[e.symbol].date) lastPastBySymbol[e.symbol] = e;
    }

    return Response.json({ events: futureEvents, past_events: Object.values(lastPastBySymbol) }, { headers: CORS_HEADERS });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500, headers: CORS_HEADERS });
  }
});
