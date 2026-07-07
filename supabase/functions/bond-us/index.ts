import { createClient } from "jsr:@supabase/supabase-js@2";

const FRED_API_KEY = Deno.env.get("FRED_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// FRED: 미국 10년물 국채 수익률 (DGS10, 일별)
Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { days } = await req.json().catch(() => ({}));

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", "DGS10");
  url.searchParams.set("api_key", FRED_API_KEY);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", days ? String(Math.min(days + 20, 2000)) : "10"); // 백필(days 지정) 시 휴장일 여유분 포함해 넉넉히 요청

  const res = await fetch(url);
  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status });
  }
  const body = await res.json();

  // FRED는 휴장일에 "." 값을 반환하므로 실제 숫자값이 있는 것만 사용
  const valid = (body.observations ?? []).filter((o: any) => o.value !== ".");
  if (!valid.length) {
    return Response.json({ error: "데이터 없음" }, { status: 404 });
  }

  if (days) {
    // 백필 모드: valid는 최신순(desc)이라 과거→최신으로 뒤집어서 전일대비 계산
    const sorted = valid.slice().reverse();
    const inserts = [];
    for (let i = 0; i < sorted.length; i++) {
      const cur = parseFloat(sorted[i].value);
      const prev = i > 0 ? parseFloat(sorted[i - 1].value) : null;
      const change = prev != null ? cur - prev : null;
      const percentChange = prev ? (change! / prev) * 100 : null;
      inserts.push({
        symbol: "US_BOND_10Y",
        price: cur,
        change,
        percent_change: percentChange,
        fetched_at: `${sorted[i].date}T21:00:00.000Z`,
      });
    }
    const exactTimestamps = inserts.map((i) => i.fetched_at);
    await supabase.from("quote_history").delete().eq("symbol", "US_BOND_10Y").in("fetched_at", exactTimestamps);
    await supabase.from("quote_history").insert(inserts);
    return Response.json({ inserted: inserts.length, range: { from: sorted[0].date, to: sorted[sorted.length - 1].date } });
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
