import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Frankfurter는 인증 없이 조회 가능한 무료 환율 API (ECB 기준)
// 히스토리 백필용: range 엔드포인트(/v1/시작일..종료일)로 1999년부터의 일별 환율을 무료로 제공
// (ECB 휴장일·주말엔 데이터가 없어 실제 거래일수만큼만 채워짐)
async function backfill(supabase: any, days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const url = `https://api.frankfurter.dev/v1/${isoDate(from)}..${isoDate(to)}?base=USD&symbols=KRW`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter 히스토리 조회 실패: ${await res.text()}`);
  const body = await res.json();
  const dates = Object.keys(body.rates ?? {}).sort();
  const inserts = [];
  for (let i = 0; i < dates.length; i++) {
    const cur = body.rates[dates[i]].KRW;
    const prev = i > 0 ? body.rates[dates[i - 1]].KRW : null;
    const change = prev ? cur - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    inserts.push({ symbol: "USD_KRW", price: cur, change, percent_change: percentChange, fetched_at: `${dates[i]}T00:00:00.000Z` });
  }
  if (inserts.length > 0) {
    const exactTimestamps = inserts.map((i) => i.fetched_at);
    await supabase.from("quote_history").delete().eq("symbol", "USD_KRW").in("fetched_at", exactTimestamps);
    await supabase.from("quote_history").insert(inserts);
  }
  return inserts.length;
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { days } = await req.json().catch(() => ({}));
  if (days) {
    const inserted = await backfill(supabase, days);
    return Response.json({ inserted });
  }

  const [today, yesterdayRes] = await Promise.all([
    fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW"),
    fetch("https://api.frankfurter.dev/v1/" + isoDate(new Date(Date.now() - 86400000)) + "?base=USD&symbols=KRW"),
  ]);
  if (!today.ok) return Response.json({ error: await today.text() }, { status: today.status });

  const todayBody = await today.json();
  const rate = todayBody.rates.KRW;
  let prevRate: number | null = null;
  if (yesterdayRes.ok) {
    const yBody = await yesterdayRes.json();
    prevRate = yBody.rates?.KRW ?? null;
  }

  const change = prevRate ? rate - prevRate : null;
  const percentChange = prevRate ? (change! / prevRate) * 100 : null;

  const quote = {
    symbol: "USD_KRW",
    price: rate,
    change,
    percent_change: percentChange,
    fetched_at: new Date().toISOString(),
  };

  // Frankfurter는 하루 1번만 갱신되는 환율이라, 그보다 자주 폴링해도 직전과 같은 값이면 중복 row로만 쌓임 — 스킵
  const { data: lastRows } = await supabase
    .from("quote_history")
    .select("price")
    .eq("symbol", "USD_KRW")
    .order("fetched_at", { ascending: false })
    .limit(1);
  const lastPrice = (lastRows ?? [])[0]?.price;
  if (lastPrice === undefined || lastPrice !== rate) {
    await supabase.from("quote_history").insert(quote);
  }

  return Response.json({ quote, inserted: lastPrice !== rate });
});

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
