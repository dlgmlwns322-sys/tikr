import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

interface Quote {
  symbol: string;
  price: number;
  change: number;
  percent_change: number;
  fetched_at: string;
}

async function sendTelegram(text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const quoteRes = await fetch(`${SUPABASE_URL}/functions/v1/finnhub-quote`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!quoteRes.ok) {
    return Response.json({ error: "finnhub-quote", detail: await quoteRes.text() }, { status: quoteRes.status });
  }
  const { quotes }: { quotes: Quote[] } = await quoteRes.json();

  const { data: watchlist, error } = await supabase
    .from("watchlist")
    .select("symbol, alert_threshold_pct")
    .eq("market", "nasdaq");
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  const thresholds = new Map((watchlist ?? []).map((w) => [w.symbol, w.alert_threshold_pct]));

  const dateStr = today();
  const alerted: string[] = [];

  for (const quote of quotes) {
    const threshold = thresholds.get(quote.symbol);
    if (threshold === undefined || quote.percent_change > threshold) continue;

    const { error: logError } = await supabase
      .from("stock_alert_log")
      .insert({ symbol: quote.symbol, alert_date: dateStr, percent_change: quote.percent_change });

    if (logError) continue; // 이미 오늘 알림 보낸 종목 (primary key 충돌)

    await sendTelegram(
      `📉 매수 고려 알림\n${quote.symbol} ${quote.percent_change.toFixed(2)}% (${quote.price}달러)\n기준: ${threshold}% 이하`,
    );
    alerted.push(quote.symbol);
  }

  return Response.json({ checked: quotes.length, alerted });
});
