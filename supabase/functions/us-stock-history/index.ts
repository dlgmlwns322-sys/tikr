import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 미국 종목 과거 일별시세 백필용(1회성 호출).
// Alpha Vantage TIME_SERIES_DAILY는 무료 티어가 최근 100거래일(compact)로 제한되고
// outputsize=full은 유료 전용으로 확인됨 — 대신 Yahoo Finance 공개 차트 API(무인증·무제한)로 교체.
// 한국 종목(KIS)과 동일하게 1년치를 기본으로 채운다.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { symbol, range } = await req.json().catch(() => ({}));
  if (!symbol) {
    return Response.json({ error: "symbol is required (예: MSFT)" }, { status: 400, headers: CORS_HEADERS });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
  url.searchParams.set("range", range || "1y");
  url.searchParams.set("interval", "1d");

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status, headers: CORS_HEADERS });
  }
  const body = await res.json();
  const result = body.chart?.result?.[0];
  if (!result) {
    return Response.json({ error: "데이터 없음", detail: body.chart?.error }, { status: 404, headers: CORS_HEADERS });
  }

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const closes: (number | null)[] = q.close ?? [];
  const opens: (number | null)[] = q.open ?? [];
  const highs: (number | null)[] = q.high ?? [];
  const lows: (number | null)[] = q.low ?? [];
  const volumes: (number | null)[] = q.volume ?? [];

  const rows = timestamps
    .map((t, i) => ({ t, open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i] }))
    .filter((r) => r.close != null)
    .sort((a, b) => a.t - b.t);

  const inserts = [];
  const ohlcRows = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i].close as number;
    const prev = i > 0 ? (rows[i - 1].close as number) : null;
    const change = prev ? cur - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    const isoTs = new Date(rows[i].t * 1000).toISOString();
    inserts.push({
      symbol,
      price: cur,
      change,
      percent_change: percentChange,
      fetched_at: isoTs,
    });
    ohlcRows.push({
      symbol,
      date: isoTs.slice(0, 10),
      open: rows[i].open ?? cur,
      high: rows[i].high ?? cur,
      low: rows[i].low ?? cur,
      close: cur,
      volume: rows[i].volume ?? null,
      percent_change: percentChange,
    });
  }

  if (inserts.length > 0) {
    // 재백필 시 중복 삽입 방지 (kis-stock-history와 동일한 패턴)
    const exactTimestamps = inserts.map((r) => r.fetched_at);
    await supabase.from("quote_history").delete().eq("symbol", symbol).in("fetched_at", exactTimestamps);
    await supabase.from("quote_history").insert(inserts);
    // 캔들차트용 일봉 OHLCV — (symbol, date) 기준 upsert
    await supabase.from("daily_ohlc").upsert(ohlcRows, { onConflict: "symbol,date" });
  }

  return Response.json(
    {
      inserted: inserts.length,
      ohlc: ohlcRows.length,
      range: inserts.length ? { from: inserts[0].fetched_at.slice(0, 10), to: inserts[inserts.length - 1].fetched_at.slice(0, 10) } : null,
    },
    { headers: CORS_HEADERS },
  );
});
