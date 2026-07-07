import { createClient } from "jsr:@supabase/supabase-js@2";

const KIS_BASE_URL = Deno.env.get("KIS_BASE_URL") ?? "https://openapi.koreainvestment.com:9443";
const KIS_APP_KEY = Deno.env.get("KIS_APP_KEY")!;
const KIS_APP_SECRET = Deno.env.get("KIS_APP_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 코스피(0001)·코스닥(1001) 지수 현재가 조회 — kis-auth로 캐시된 토큰 재사용
const INDEXES: Record<string, string> = { "0001": "KOSPI", "1001": "KOSDAQ" };

async function getToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kis-auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`kis-auth 호출 실패 (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

async function fetchIndex(token: string, code: string) {
  const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "U");
  url.searchParams.set("FID_INPUT_ISCD", code);

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHPUP02100000",
      custtype: "P",
    },
  });
  if (!res.ok) throw new Error(`KIS 지수 조회 실패 (${code}, ${res.status}): ${await res.text()}`);
  return await res.json();
}

function isoCompact(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 코스피/코스닥 지수 과거 일별시세 백필용(1회성 호출). 개별종목(kis-stock-history)과 동일한 KIS
// 기간별시세 계열 API(국내주식업종기간별시세)를 사용 — 1회 호출당 최대 100건이라 100일 단위로 쪼개서 이어붙임.
async function fetchIndexChunk(token: string, code: string, from: Date, to: Date) {
  const url = new URL(`${KIS_BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice`);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "U");
  url.searchParams.set("FID_INPUT_ISCD", code);
  url.searchParams.set("FID_INPUT_DATE_1", isoCompact(from));
  url.searchParams.set("FID_INPUT_DATE_2", isoCompact(to));
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHKUP03500100",
      custtype: "P",
    },
  });
  const body = await res.json();
  if (!res.ok || body.rt_cd !== "0") {
    throw new Error(`지수 과거시세 조회 실패(${isoCompact(from)}~${isoCompact(to)}): ${JSON.stringify(body)}`);
  }
  return body.output2 ?? [];
}

async function backfillIndex(supabase: any, token: string, code: string, name: string, totalDays: number) {
  const CHUNK_DAYS = 100;
  const to = new Date();
  const allRows: any[] = [];
  const seenDates = new Set<string>();
  let chunkEnd = to;
  let remaining = totalDays;
  while (remaining > 0) {
    const span = Math.min(CHUNK_DAYS, remaining);
    const chunkStart = new Date(chunkEnd.getTime() - span * 24 * 60 * 60 * 1000);
    const rows = await fetchIndexChunk(token, code, chunkStart, chunkEnd);
    for (const r of rows) {
      if (r.stck_bsop_date && !seenDates.has(r.stck_bsop_date)) {
        seenDates.add(r.stck_bsop_date);
        allRows.push(r);
      }
    }
    remaining -= span;
    chunkEnd = new Date(chunkStart.getTime() - 24 * 60 * 60 * 1000);
    await sleep(1100); // KIS 초당 거래건수 제한 회피 (구간 사이 + 다음 지수로 넘어가기 전에도 적용됨)
  }

  const sorted = allRows.slice().sort((a, b) => a.stck_bsop_date.localeCompare(b.stck_bsop_date));
  const inserts = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = parseFloat(sorted[i].bstp_nmix_prpr ?? "0");
    const prev = i > 0 ? parseFloat(sorted[i - 1].bstp_nmix_prpr ?? "0") : null;
    const change = prev ? cur - prev : null;
    const percentChange = prev ? (change! / prev) * 100 : null;
    const d = sorted[i].stck_bsop_date;
    const isoDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T06:00:00.000Z`;
    inserts.push({ symbol: name, price: cur, change, percent_change: percentChange, fetched_at: isoDate });
  }
  if (inserts.length > 0) {
    const exactTimestamps = inserts.map((i) => i.fetched_at);
    await supabase.from("quote_history").delete().eq("symbol", name).in("fetched_at", exactTimestamps);
    await supabase.from("quote_history").insert(inserts);
  }
  return inserts.length;
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const token = await getToken();

  const { days } = await req.json().catch(() => ({}));
  if (days) {
    const counts: Record<string, number> = {};
    for (const [code, name] of Object.entries(INDEXES)) {
      counts[name] = await backfillIndex(supabase, token, code, name, days);
    }
    return Response.json({ inserted: counts });
  }

  const results = [];
  let first = true;
  for (const [code, name] of Object.entries(INDEXES)) {
    if (!first) await new Promise((r) => setTimeout(r, 1100)); // KIS 초당 거래건수 제한 회피
    first = false;
    try {
      const data = await fetchIndex(token, code);
      const out = data.output ?? {};
      // prdy_vrss_sign: 1=상한 2=상승 3=보합 4=하한 5=하락 (KIS 공통 부호코드) — 하락일 땐 음수로 변환
      const isDown = out.prdy_vrss_sign === "4" || out.prdy_vrss_sign === "5";
      const rawChange = Math.abs(parseFloat(out.bstp_nmix_prdy_vrss ?? "0"));
      const rawPct = Math.abs(parseFloat(out.bstp_nmix_prdy_ctrt ?? "0"));
      results.push({
        symbol: name,
        price: parseFloat(out.bstp_nmix_prpr ?? out.bstp_nmix_pric ?? "0"),
        change: isDown ? -rawChange : rawChange,
        percent_change: isDown ? -rawPct : rawPct,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      results.push({ symbol: name, error: (e as Error).message });
    }
  }

  const ok = results.filter((r) => !("error" in r)) as any[];

  // 장 마감 중(야간·주말)에도 계속 폴링하면 직전과 동일한 가격이 매번 새 row로 쌓여
  // MSFT/QQQ에서 겪었던 "평평한 선+끝에 튀는 점" 차트 버그가 재발함 — 직전 저장값과 가격이 같으면 스킵
  const lastRows = await Promise.all(
    ok.map(async (r) => {
      const { data } = await supabase
        .from("quote_history")
        .select("price")
        .eq("symbol", r.symbol)
        .order("fetched_at", { ascending: false })
        .limit(1);
      return { symbol: r.symbol, lastPrice: (data ?? [])[0]?.price };
    }),
  );
  const lastPriceBySymbol = Object.fromEntries(lastRows.map((r) => [r.symbol, r.lastPrice]));
  const inserts = ok.filter((r) => lastPriceBySymbol[r.symbol] === undefined || lastPriceBySymbol[r.symbol] !== r.price);

  if (inserts.length > 0) {
    await supabase.from("quote_history").insert(
      inserts.map((r) => ({
        symbol: r.symbol,
        price: r.price,
        change: r.change,
        percent_change: r.percent_change,
        fetched_at: r.fetched_at,
      })),
    );
  }

  return Response.json({ results, inserted: inserts.length });
});
