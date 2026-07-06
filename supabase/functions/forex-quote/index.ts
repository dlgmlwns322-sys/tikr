import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Frankfurter는 인증 없이 조회 가능한 무료 환율 API (ECB 기준)
Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

  await supabase.from("quote_history").insert(quote);

  return Response.json({ quote });
});

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
