import { createClient } from "jsr:@supabase/supabase-js@2";

const ECOS_API_KEY = Deno.env.get("ECOS_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 한국은행 ECOS: 국고채(3년) 유통수익률, 통계표 817Y002, 항목코드 010200000 (일별)
function isoCompact(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const to = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000); // 최근 2주 (휴장일 감안 최근 2개 영업일 확보)

  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_API_KEY}/json/kr/1/20/817Y002/D/${isoCompact(from)}/${isoCompact(to)}/010200000`;
  const res = await fetch(url);
  if (!res.ok) {
    return Response.json({ error: await res.text() }, { status: res.status });
  }
  const body = await res.json();

  if (body.RESULT) {
    return Response.json({ error: body.RESULT.MESSAGE ?? "ECOS 오류" }, { status: 502 });
  }

  const rows = (body.StatisticSearch?.row ?? []).sort((a: any, b: any) => a.TIME.localeCompare(b.TIME));
  if (!rows.length) {
    return Response.json({ error: "데이터 없음" }, { status: 404 });
  }
  const latest = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;

  const price = parseFloat(latest.DATA_VALUE);
  const prevPrice = prev ? parseFloat(prev.DATA_VALUE) : null;
  const change = prevPrice != null ? price - prevPrice : null;
  const percentChange = prevPrice ? (change! / prevPrice) * 100 : null;

  const quote = {
    symbol: "KR_BOND_3Y",
    price,
    change,
    percent_change: percentChange,
    fetched_at: new Date().toISOString(),
  };

  await supabase.from("quote_history").insert(quote);

  return Response.json({ quote, latest_date: latest.TIME });
});
