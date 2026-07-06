import { createClient } from "jsr:@supabase/supabase-js@2";

const FRED_API_KEY = Deno.env.get("FRED_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// FRED: 미국 10년물 국채 수익률 (DGS10, 일별)
Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", "DGS10");
  url.searchParams.set("api_key", FRED_API_KEY);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "10");

  const res = await fetch(url);
  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status });
  }
  const body = await res.json();

  // FRED는 휴장일에 "." 값을 반환하므로 실제 숫자값이 있는 최근 2개를 찾는다
  const valid = (body.observations ?? []).filter((o: any) => o.value !== ".");
  if (!valid.length) {
    return Response.json({ error: "데이터 없음" }, { status: 404 });
  }
  const latest = valid[0];
  const prev = valid[1] ?? null;

  const price = parseFloat(latest.value);
  const prevPrice = prev ? parseFloat(prev.value) : null;
  const change = prevPrice != null ? price - prevPrice : null;
  const percentChange = prevPrice ? (change! / prevPrice) * 100 : null;

  const quote = {
    symbol: "US_BOND_10Y",
    price,
    change,
    percent_change: percentChange,
    fetched_at: new Date().toISOString(),
  };

  await supabase.from("quote_history").insert(quote);

  return Response.json({ quote, latest_date: latest.date });
});
