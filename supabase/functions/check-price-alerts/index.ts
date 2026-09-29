import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

// 지수·환율·원자재·코인·채권·개별종목 등 앱에서 보이는 모든 심볼에 걸어둔 퍼센트/금액 알림을 체크하는 함수.
// 기존 stock-alert(나스닥 종목 전용, 퍼센트 하락만)를 대체한다.
//
// 핵심: 미국 종목은 장 시간이 한국시간 기준 자정을 걸쳐서 진행되기 때문에(예: EDT 기준 22:30~05:00 KST),
// "오늘 하루" 판단을 KST 달력일로 하면 같은 거래 세션인데도 자정이 지나면 새 세션으로 착각해서
// 퍼센트 알림이 중복으로 올 수 있음(혹은 반대로 세션이 안 끝났는데 리셋되는 문제) — 그래서 심볼의
// 실제 거래 시장 기준 로컬 날짜로 세션 키를 계산한다.
function isKrSymbol(symbol: string): boolean {
  return /\.(KS|KQ)$/.test(symbol) || ["KOSPI", "KOSDAQ", "KR_BOND_3Y"].includes(symbol);
}
function sessionKeyFor(symbol: string, at: Date = new Date()): string {
  const tz = isKrSymbol(symbol) ? "Asia/Seoul" : "America/New_York";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}

function priceFmt(symbol: string, n: number): string {
  const s = Math.abs(n).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  if (/\.(KS|KQ)$/.test(symbol) || symbol === "USD_KRW" || symbol === "BTC_KRW") return s + "원";
  if (symbol === "KR_BOND_3Y" || symbol === "US_BOND_10Y") return s + "%";
  if (symbol === "KOSPI" || symbol === "KOSDAQ") return s;
  return "$" + s;
}

// 전송 성공 여부를 돌려준다. 실패하면 호출한 쪽이 발동 기록을 되돌려 다음 실행(1분 뒤)에 다시 시도한다.
async function sendTelegram(text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

// 오래된 시세로 알림이 발동하지 않게(정지·수집 실패 뒤 재개 등) 최신 행의 시각을 본다.
// - 등락률(pct): 그날 세션의 등락이므로 지금 거래 세션 것만. 장 마감 뒤에도 같은 세션이면 평가(2026-09-23 규칙).
//   채권·금·유가는 하루 1회(UTC 0시대) 수집이라 세션 날짜가 어긋나므로 26시간 이내면 쓴다.
// - 목표가(price): 마지막 시세가 목표에 닿았는지라 주말·연휴 뒤에도 유효 → 5일 이내.
const DAILY_SYMBOLS = ["KR_BOND_3Y", "US_BOND_10Y", "XAUUSD", "BRENT_CRUDE"];
function isFresh(symbol: string, kind: string, fetchedAt: string, now: Date): boolean {
  const t = new Date(fetchedAt);
  if (!Number.isFinite(t.getTime())) return false;
  const age = now.getTime() - t.getTime();
  if (kind === "price") return age <= 5 * 86400_000;
  if (DAILY_SYMBOLS.includes(symbol)) return age <= 26 * 3600_000;
  return sessionKeyFor(symbol, t) === sessionKeyFor(symbol, now);
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 나스닥 개별종목 시세는 별도 크론 없이 이 함수(1분 간격)가 finnhub-quote를 호출하는 김에
  // 같이 갱신되던 구조였음(예전 stock-alert 때부터의 패턴) — 그대로 유지해서 quote_history가
  // 계속 최신으로 쌓이게 한다.
  await fetch(`${SUPABASE_URL}/functions/v1/finnhub-quote`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  }).catch(() => {});

  const { data: alerts, error } = await supabase
    .from("price_alerts")
    .select("id,symbol,kind,direction,threshold,last_fired_session")
    .eq("enabled", true);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!alerts || alerts.length === 0) return Response.json({ checked: 0, fired: [] });

  const symbols = [...new Set(alerts.map((a) => a.symbol))];

  // 심볼별 최신 1행: 먼저 1회 조회(fetched_at 내림차순 상위 2N행)로 받고, 거기 없던 심볼만 기존처럼 개별 조회.
  // 상위 2N행 안에 등장한 심볼의 첫 행은 그 심볼의 최신 행이므로 결과는 심볼별 개별 조회와 같다.
  const latestBySymbol: Record<string, { price: number; percent_change: number; fetched_at: string }> = {};
  const { data: recent } = await supabase
    .from("quote_history")
    .select("symbol, price, percent_change, fetched_at")
    .in("symbol", symbols)
    .order("fetched_at", { ascending: false })
    .limit(symbols.length * 2);
  for (const row of recent ?? []) {
    if (!latestBySymbol[row.symbol]) {
      latestBySymbol[row.symbol] = { price: row.price, percent_change: row.percent_change, fetched_at: row.fetched_at };
    }
  }
  await Promise.all(
    symbols.filter((symbol) => !latestBySymbol[symbol]).map(async (symbol) => {
      const { data } = await supabase
        .from("quote_history")
        .select("price, percent_change, fetched_at")
        .eq("symbol", symbol)
        .order("fetched_at", { ascending: false })
        .limit(1);
      if (data && data[0]) latestBySymbol[symbol] = data[0];
    }),
  );

  const now = new Date();
  const fired: string[] = [];
  const failed: string[] = [];
  for (const alert of alerts) {
    const quote = latestBySymbol[alert.symbol];
    if (!quote || !isFresh(alert.symbol, alert.kind, quote.fetched_at, now)) continue;

    const value = alert.kind === "pct" ? quote.percent_change : quote.price;
    const conditionMet = alert.direction === "below" ? value <= alert.threshold : value >= alert.threshold;
    if (!conditionMet) continue;

    if (alert.kind === "price") {
      // 목표가 알림은 1회성 — 발동 즉시 꺼서 다시 안 옴. .eq("enabled", true)로 갱신된 행만 select돼서
      // 돌아오므로(0건이면 이미 다른 실행에서 처리됨), 그 결과로만 알림 발송 여부를 판단한다.
      const { data: updated } = await supabase
        .from("price_alerts")
        .update({ enabled: false })
        .eq("id", alert.id)
        .eq("enabled", true)
        .select("id");
      if (updated && updated.length > 0) {
        const sent = await sendTelegram(
          `🎯 목표가 도달\n${alert.symbol} ${priceFmt(alert.symbol, quote.price)}\n기준: ${alert.direction === "below" ? "이하" : "이상"} ${priceFmt(alert.symbol, alert.threshold)}`,
        );
        if (sent) {
          fired.push(`${alert.symbol}(price)`);
        } else {
          // 전송 실패: 다시 켜서 다음 실행에 재시도
          await supabase.from("price_alerts").update({ enabled: true }).eq("id", alert.id).eq("enabled", false);
          failed.push(`${alert.symbol}(price)`);
        }
      }
    } else {
      const session = sessionKeyFor(alert.symbol);
      if (alert.last_fired_session === session) continue; // 이번 세션엔 이미 발동함

      // 같은 조건으로 먼저 기록해 중복 발송을 막고(동시 실행 대비), 전송 실패면 이전 값으로 되돌린다.
      const prevSession = alert.last_fired_session;
      const { data: claimed } = await supabase
        .from("price_alerts")
        .update({ last_fired_session: session })
        .eq("id", alert.id)
        .or(prevSession == null ? "last_fired_session.is.null" : `last_fired_session.eq.${prevSession}`)
        .select("id");
      if (!claimed || claimed.length === 0) continue;
      const sent = await sendTelegram(
        `📉 알림\n${alert.symbol} ${quote.percent_change.toFixed(2)}% (${priceFmt(alert.symbol, quote.price)})\n기준: ${alert.direction === "below" ? "이하" : "이상"} ${alert.threshold}%`,
      );
      if (sent) {
        fired.push(`${alert.symbol}(pct)`);
      } else {
        await supabase.from("price_alerts").update({ last_fired_session: prevSession }).eq("id", alert.id).eq("last_fired_session", session);
        failed.push(`${alert.symbol}(pct)`);
      }
    }
  }

  return Response.json({ checked: alerts.length, fired, failed });
});
