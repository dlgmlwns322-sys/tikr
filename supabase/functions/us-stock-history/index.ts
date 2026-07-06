import { createClient } from "jsr:@supabase/supabase-js@2";

const ALPHAVANTAGE_API_KEY = Deno.env.get("ALPHAVANTAGE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 미국 종목 과거 일별시세 백필용(1회성 호출). Finnhub 무료 티어는 캔들(과거시세)이 유료 전용이라
// Alpha Vantage(무료, 하루 25회 제한)로 대체. TIME_SERIES_DAILY 사용.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol } = await req.json().catch(() => ({}));
  if (!symbol) {
    return Response.json({ error: "symbol is required (예: MSFT)" }, { status: 400, headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "TIME_SERIES_DAILY");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("outputsize", "compact"); // 최근 100거래일
  url.searchParams.set("apikey", ALPHAVANTAGE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status, headers: CORS_HEADERS });
  }
  const body = await res.json();
  if (body.Note || body.Information) {
    // 무료 티어 한도 초과 등은 200으로 오면서 별도 메시지 필드로 옴
    return Response.json({ error: body.Note || body.Information }, { status: 429, headers: CORS_HEADERS });
  }
  const series = body["Time Series (Daily)"];
  if (!series) {
    return Response.json({ error: "데이터 없음", detail: body }, { status: 404, headers: CORS_HEADERS });
  }

  const dates = Object.keys(series).sort(); // 과거→최신
  const inserts = [];
  for (let i = 0; i < dates.length; i++) {
    const cur = parseFloat(series[dates[i]]["4. close"]);
    const prevClose = i > 0 ? parseFloat(series[dates[i - 1]]["4. close"]) : null;
    const change = prevClose ? cur - prevClose : null;
    const percentChange = prevClose ? (change! / prevClose) * 100 : null;
    inserts.push({
      symbol,
      price: cur,
      change,
      percent_change: percentChange,
      fetched_at: `${dates[i]}T21:00:00.000Z`, // 미국 장마감(16:00 ET)쯤을 UTC로 대략 표기
    });
  }

  if (inserts.length > 0) {
    await supabase.from("quote_history").insert(inserts);
  }

  return Response.json({ inserted: inserts.length, range: { from: dates[0], to: dates[dates.length - 1] } }, { headers: CORS_HEADERS });
});
