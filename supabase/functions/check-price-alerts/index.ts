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
function sessionKeyFor(symbol: string): string {
  const tz = isKrSymbol(symbol) ? "Asia/Seoul" : "America/New_York";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

function priceFmt(symbol: string, n: number): string {
  const s = Math.abs(n).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  if (/\.(KS|KQ)$/.test(symbol) || symbol === "USD_KRW" || symbol === "BTC_KRW") return s + "원";
  if (symbol === "KR_BOND_3Y" || symbol === "US_BOND_10Y") return s + "%";
  if (symbol === "KOSPI" || symbol === "KOSDAQ") return s;
  return "$" + s;
}

async function sendTelegram(text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
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

  const { data: alerts, error } = await supabase.from("price_alerts").select("*").eq("enabled", true);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!alerts || alerts.length === 0) return Response.json({ checked: 0, fired: [] });

  const symbols = [...new Set(alerts.map((a) => a.symbol))];
  const latestBySymbol: Record<string, { price: number; percent_change: number }> = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      const { data } = await supabase
        .from("quote_history")
        .select("price, percent_change")
        .eq("symbol", symbol)
        .order("fetched_at", { ascending: false })
        .limit(1);
      if (data && data[0]) latestBySymbol[symbol] = data[0];
    }),
  );

  const fired: string[] = [];
  for (const alert of alerts) {
    const quote = latestBySymbol[alert.symbol];
    if (!quote) continue;

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
        .select();
      if (updated && updated.length > 0) {
        await sendTelegram(
          `🎯 목표가 도달\n${alert.symbol} ${priceFmt(alert.symbol, quote.price)}\n기준: ${alert.direction === "below" ? "이하" : "이상"} ${priceFmt(alert.symbol, alert.threshold)}`,
        );
        fired.push(`${alert.symbol}(price)`);
      }
    } else {
      const session = sessionKeyFor(alert.symbol);
      if (alert.last_fired_session === session) continue; // 이번 세션엔 이미 발동함

      await supabase.from("price_alerts").update({ last_fired_session: session }).eq("id", alert.id);
      await sendTelegram(
        `📉 알림\n${alert.symbol} ${quote.percent_change.toFixed(2)}% (${priceFmt(alert.symbol, quote.price)})\n기준: ${alert.direction === "below" ? "이하" : "이상"} ${alert.threshold}%`,
      );
      fired.push(`${alert.symbol}(pct)`);
    }
  }

  return Response.json({ checked: alerts.length, fired });
});
