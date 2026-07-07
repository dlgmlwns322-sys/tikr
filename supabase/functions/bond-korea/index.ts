import { createClient } from "jsr:@supabase/supabase-js@2";

const ECOS_API_KEY = Deno.env.get("ECOS_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 한국은행 ECOS: 국고채(3년) 유통수익률, 통계표 817Y002, 항목코드 010200000 (일별)
function isoCompact(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { days } = await req.json().catch(() => ({}));

  const to = new Date();
  const from = new Date(to.getTime() - (days ?? 14) * 24 * 60 * 60 * 1000); // 평소엔 최근 2주(휴장일 감안 최근 2개 영업일 확보), days 지정 시 백필용

  // ECOS는 요청 구간(start~end index)만큼 응답 가능 — 백필(days 지정) 시엔 넉넉히 400건까지 허용
  const endIdx = days ? 400 : 20;
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_API_KEY}/json/kr/1/${endIdx}/817Y002/D/${isoCompact(from)}/${isoCompact(to)}/010200000`;
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

  if (days) {
    // 백필 모드: 구간 전체를 일별 시세로 채워넣음 (재백필 시 중복 방지를 위해 정확한 타임스탬프만 지우고 다시 채움)
    const inserts = [];
    for (let i = 0; i < rows.length; i++) {
      const cur = parseFloat(rows[i].DATA_VALUE);
      const prev = i > 0 ? parseFloat(rows[i - 1].DATA_VALUE) : null;
      const change = prev != null ? cur - prev : null;
      const percentChange = prev ? (change! / prev) * 100 : null;
      const d = rows[i].TIME; // YYYYMMDD
      const isoDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T06:00:00.000Z`;
      inserts.push({ symbol: "KR_BOND_3Y", price: cur, change, percent_change: percentChange, fetched_at: isoDate });
    }
    const exactTimestamps = inserts.map((i) => i.fetched_at);
    await supabase.from("quote_history").delete().eq("symbol", "KR_BOND_3Y").in("fetched_at", exactTimestamps);
    await supabase.from("quote_history").insert(inserts);
    return Response.json({ inserted: inserts.length, range: { from: isoCompact(from), to: isoCompact(to) } });
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
