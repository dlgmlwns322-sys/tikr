import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('24시간 자동 수집은 BTC_KRW 하나를 15분 간격으로 유지한다', () => {
  const macro = read('supabase/functions/macro-poll/index.ts');
  const upbit = read('supabase/functions/upbit-quote/index.ts');

  assert.doesNotMatch(macro, /call\("binance-quote"\)/);
  assert.match(macro, /minute\s*%\s*15\s*<\s*5/);
  assert.match(macro, /if\s*\(isUpbitSlot\(startMinute\)\)\s*results\.push\(await call\("upbit-quote"\)\)/);
  assert.match(upbit, /const MARKETS = \["KRW-BTC"\];/);
});

// ---- 앱(index.html, v9.2) 조회량 ----
// 2026-10-01 앱 교체: 큰 표(시세 기록·일봉)는 앱이 직접 읽지 않고 DB 공개 함수 결과 JSON(수 KB)만 받는다.
// 옛 앱(legacy.html)의 차트 조회 시험은 앱 교체로 대상이 없어져 이 시험들로 바꿨다.
const APP_RPCS = new Set(['tikr_home_json', 'tikr_discover_json', 'tikr_theme_json', 'tikr_stock_json', 'tikr_holdings_json',
  'tikr_search_json', 'tikr_feedback_add', 'tikr_track_symbol', 'tikr_portfolio_score_json']);

test('앱은 큰 표를 직접 조회하지 않고 관심종목 표만 필요한 열로 읽는다', () => {
  const html = read('index.html');
  const tables = new Set([...html.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]));
  assert.deepEqual([...tables], ['watchlist']);
  assert.doesNotMatch(html, /from\('watchlist'\)\.select\('\*'\)/);
  assert.match(html, /from\('watchlist'\)\.select\('symbol,market,sort_order'\)/);
});

test('앱이 부르는 DB 함수는 앱용 공개 함수뿐이다', () => {
  const html = read('index.html');
  const rpcs = [...html.matchAll(/(?:\brpc|callRpc)\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(rpcs.length >= 8);
  for (const r of rpcs) assert.ok(APP_RPCS.has(r), r);
});

test('앱: 보유·관심 목록 60개·포트폴리오 점수 30평가일 상한', () => {
  const html = read('index.html');
  assert.match(html, /\.slice\(0, 60\)/);
  assert.match(html, /tikr_portfolio_score_json[^\n]*p_n: 30/);
});

// ---- check-price-alerts / macro-poll 조회·응답량 회귀 검사 ----

// Edge Function 소스를 jsr import 없이 실행해 Deno.serve 핸들러를 꺼낸다. Date·fetch·createClient는 주입한 가짜로 대체.
// now는 고정 시각 문자열 또는 현재 시각을 돌려주는 함수(실행 중 시간 경과 흉내).
function loadHandler(path, { now, createClient, fetch }) {
  const js = stripTypeScriptTypes(read(path).replace(/^import .*$/m, ''));
  let handler;
  const clock = typeof now === 'function' ? now : () => now;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock()])); }
  }
  const Deno = { env: { get: () => 'x' }, serve: (fn) => { handler = fn; } };
  new Function('Deno', 'createClient', 'fetch', 'Date', js)(Deno, createClient, fetch, FakeDate);
  return handler;
}

// PostgREST 체인을 흉내 내는 최소 가짜 클라이언트. 요청을 기록한다.
function fakeSupabase({ alerts, quotes, revertErrors = 0 }) {
  const log = [];
  let revertLeft = revertErrors; // 되돌리기 갱신(enabled=true 또는 세션 조건)의 앞 N번을 DB 오류로
  const run = (q) => {
    if (q.table === 'price_alerts' && q.op === 'select') return { data: alerts.filter((a) => a.enabled), error: null };
    if (q.table === 'price_alerts' && q.op === 'update') {
      const id = q.filters.find((f) => f[1] === 'id')[2];
      const a = alerts.find((x) => x.id === id);
      // eq·or 조건이 현재 행과 맞지 않으면 갱신 0건(조건부 갱신 흉내)
      const miss = q.filters.some(([op, k, v]) => {
        if (op === 'eq' && k !== 'id') return a[k] !== v;
        if (op === 'or') return v === 'last_fired_session.is.null' ? a.last_fired_session != null : `last_fired_session.eq.${a.last_fired_session}` !== v;
        return false;
      });
      const isRevert = q.value.enabled === true || q.filters.some(([op, k]) => op === 'eq' && k === 'last_fired_session');
      if (isRevert && revertLeft > 0) { revertLeft--; return { data: null, error: { message: 'db down' } }; }
      if (miss) return { data: [], error: null };
      Object.assign(a, q.value);
      return { data: q.cols ? [{ id }] : null, error: null };
    }
    if (q.table === 'quote_history') {
      const inF = q.filters.find((f) => f[0] === 'in');
      const eqF = q.filters.find((f) => f[0] === 'eq' && f[1] === 'symbol');
      const rows = [...quotes]
        .sort((x, y) => y.fetched_at.localeCompare(x.fetched_at))
        .filter((r) => (!inF || inF[2].includes(r.symbol)) && (!eqF || r.symbol === eqF[2]));
      return { data: rows.slice(0, q.limit), error: null };
    }
    throw new Error('unexpected query ' + JSON.stringify(q));
  };
  const client = {
    from(table) {
      const q = { table, op: 'select', filters: [], cols: null };
      const b = {
        select(cols) { q.cols = cols ?? '*'; return b; },
        update(v) { q.op = 'update'; q.value = v; return b; },
        eq(k, v) { q.filters.push(['eq', k, v]); return b; },
        in(k, v) { q.filters.push(['in', k, v]); return b; },
        or(v) { q.filters.push(['or', null, v]); return b; },
        order() { return b; },
        limit(n) { q.limit = n; return b; },
        then(res, rej) { log.push(q); return Promise.resolve(run(q)).then(res, rej); },
      };
      return b;
    },
  };
  return { client, log };
}

async function runAlerts({ now, alerts, quotes, telegramFails = false, revertErrors = 0 }) {
  const { client, log } = fakeSupabase({ alerts, quotes, revertErrors });
  const sent = [];
  const fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) {
      if (telegramFails) return new Response('{"ok":false}', { status: 500 });
      sent.push(JSON.parse(init.body).text);
      return new Response('{"ok":true}'); // 실제 Telegram 성공 응답 모양
    }
    return new Response('{}');
  };
  const handler = loadHandler('supabase/functions/check-price-alerts/index.ts', { now, createClient: () => client, fetch });
  const body = await (await handler()).json();
  return { body, log, sent, alerts };
}

// 2026-09-26(토) 12:00 KST — 한국·미국 장 모두 닫힘
const WEEKEND = '2026-09-26T03:00:00Z';
// 2026-09-23(수) 10:00 KST — 한국장 열림, 미국장 닫힘
const KR_OPEN = '2026-09-23T01:00:00Z';

test('check-price-alerts는 price_alerts를 필요한 컬럼만 조회한다', () => {
  const src = read('supabase/functions/check-price-alerts/index.ts');
  assert.doesNotMatch(src, /\.select\("\*"\)/);
  assert.doesNotMatch(src, /\.select\(\)/);
  assert.match(src, /\.select\("id,symbol,kind,direction,threshold,last_fired_session"\)/);
});

test('check-price-alerts: 장 마감 조기 종료 없이 장외에도 정규장 심볼 알림을 평가한다', async () => {
  const src = read('supabase/functions/check-price-alerts/index.ts');
  assert.doesNotMatch(src, /markets closed/);
  assert.doesNotMatch(src, /MarketOpen/);

  const alerts = [
    { id: 1, symbol: 'AAPL', kind: 'pct', direction: 'below', threshold: -1, last_fired_session: null, enabled: true },
    { id: 2, symbol: '005930.KS', kind: 'price', direction: 'above', threshold: 1, last_fired_session: null, enabled: true },
  ];
  const quotes = [
    { symbol: 'AAPL', price: 100, percent_change: -5, fetched_at: '2026-09-25T19:59:00Z' },
    { symbol: '005930.KS', price: 70000, percent_change: 1, fetched_at: '2026-09-25T06:29:00Z' },
  ];
  const r = await runAlerts({ now: WEEKEND, alerts, quotes });
  assert.equal(r.body.skipped, undefined);
  assert.equal(r.body.checked, 2);
  assert.deepEqual(r.body.fired.sort(), ['005930.KS(price)', 'AAPL(pct)']);
  assert.equal(r.sent.length, 2);
  assert.equal(r.alerts[1].enabled, false);
});

test('check-price-alerts: 24시간 시장 심볼(코인)과 섞여 있어도 장 마감에 전체를 평가한다', async () => {
  const alerts = [
    { id: 1, symbol: 'AAPL', kind: 'pct', direction: 'below', threshold: -1, last_fired_session: null, enabled: true },
    { id: 2, symbol: 'BTC_KRW', kind: 'price', direction: 'above', threshold: 100, last_fired_session: null, enabled: true },
  ];
  const quotes = [
    { symbol: 'AAPL', price: 100, percent_change: -5, fetched_at: '2026-09-25T19:59:00Z' },
    { symbol: 'BTC_KRW', price: 150, percent_change: 0.5, fetched_at: '2026-09-26T02:45:00Z' },
  ];
  const r = await runAlerts({ now: WEEKEND, alerts, quotes });
  assert.equal(r.body.skipped, undefined);
  assert.deepEqual(r.body.fired.sort(), ['AAPL(pct)', 'BTC_KRW(price)']);
  assert.equal(r.alerts[1].enabled, false);
});

test('check-price-alerts: 최신가는 묶음 1회 조회 + 빠진 심볼만 개별 조회로 심볼별 최신 행을 쓴다', async () => {
  const alerts = [
    { id: 1, symbol: 'KOSPI', kind: 'pct', direction: 'above', threshold: 1, last_fired_session: null, enabled: true },
    { id: 2, symbol: 'USD_KRW', kind: 'price', direction: 'below', threshold: 1300, last_fired_session: null, enabled: true },
  ];
  const quotes = [
    // KOSPI 최근 행이 상위 4행을 채워서 USD_KRW는 묶음 조회에 안 들어온다 → 개별 조회로 보충
    ...[0, 1, 2, 3, 4].map((i) => ({ symbol: 'KOSPI', price: 3000 + i, percent_change: i === 4 ? 1.5 : 0.1, fetched_at: `2026-09-23T00:5${i}:00Z` })),
    { symbol: 'USD_KRW', price: 1290, percent_change: -0.2, fetched_at: '2026-09-22T23:00:00Z' },
    { symbol: 'USD_KRW', price: 1350, percent_change: 0.1, fetched_at: '2026-09-22T22:00:00Z' },
  ];
  const r = await runAlerts({ now: KR_OPEN, alerts, quotes });
  assert.deepEqual(r.body.fired.sort(), ['KOSPI(pct)', 'USD_KRW(price)']);
  assert.match(r.sent.find((t) => t.includes('KOSPI')), /1\.50%/);
  const qh = r.log.filter((q) => q.table === 'quote_history');
  assert.equal(qh.length, 2); // 묶음 1회 + USD_KRW 개별 1회 (KOSPI는 개별 조회 안 함)
  assert.ok(qh[0].filters.some((f) => f[0] === 'in'));
  assert.deepEqual(qh[1].filters.find((f) => f[1] === 'symbol'), ['eq', 'symbol', 'USD_KRW']);

  // 같은 세션 재실행: pct 알림은 다시 안 오고, 1회성 목표가 알림은 이미 꺼져 있다
  const again = await runAlerts({ now: KR_OPEN, alerts: r.alerts, quotes });
  assert.deepEqual(again.body.fired, []);
});

test('macro-poll은 하위 함수 body를 싣지 않고 path·ok·status 요약만 반환한다', async () => {
  const src = read('supabase/functions/macro-poll/index.ts');
  assert.match(src, /return \{ path, ok: res\.ok, status: res\.status \};/);

  const fetch = async () => new Response(JSON.stringify({ huge: 'x'.repeat(5000) }));
  // 2026-09-23(수) 10:00 KST(한국장 열림) + 분 % 15 === 0 → 4개 하위 함수 모두 호출
  const handler = loadHandler('supabase/functions/macro-poll/index.ts', { now: KR_OPEN, createClient: null, fetch });
  const body = await (await handler()).json();
  assert.deepEqual(body.results.map((r) => r.path), ['kis-index', 'kis-stock-quote', 'forex-quote', 'upbit-quote']);
  for (const r of body.results) assert.deepEqual(Object.keys(r).sort(), ['ok', 'path', 'status']);
  assert.ok(JSON.stringify(body).length < 300);
});

// macro-poll을 실행해 호출된 하위 함수 경로를 돌려준다. advance: 하위 호출마다 시계를 진행할 ms(선행 await 지연 흉내).
async function runMacro(startIso, advance = 0) {
  let t = new Date(startIso).getTime();
  const called = [];
  const fetch = async (url) => {
    called.push(String(url).split('/').pop());
    t += advance;
    return new Response('{}');
  };
  const handler = loadHandler('supabase/functions/macro-poll/index.ts', { now: () => new Date(t).toISOString(), createClient: null, fetch });
  await handler();
  return called;
}

test('macro-poll: 업비트는 시작분 % 15 < 5 슬롯에서만 호출한다 (크론 1~4분 지연 허용)', async () => {
  // 주말 12:MM KST(=03:MM UTC) — KIS 건너뜀, 환율 + (슬롯이면) 업비트
  for (const m of [0, 1, 4, 15, 16, 34, 49]) {
    const called = await runMacro(`2026-09-26T03:${String(m).padStart(2, '0')}:00Z`);
    assert.ok(called.includes('upbit-quote'), `${m}분 통과해야 함`);
  }
  for (const m of [5, 14, 20, 29, 59]) {
    const called = await runMacro(`2026-09-26T03:${String(m).padStart(2, '0')}:00Z`);
    assert.ok(!called.includes('upbit-quote'), `${m}분 불통과해야 함`);
  }
});

test('macro-poll: 선행 호출이 분을 넘겨도 함수 시작분 기준으로 판정한다', async () => {
  // 한국장 10:04 시작 → KIS·환율 3회 호출 동안 분당 1분씩 흘러 10:07 → 시작분 4 기준으로 통과
  const late = await runMacro('2026-09-23T01:04:00Z', 60000);
  assert.deepEqual(late, ['kis-index', 'kis-stock-quote', 'forex-quote', 'upbit-quote']);
  // 09:59 시작 → 선행 호출 뒤 10:02가 돼도 시작분 59(슬롯 밖) 기준으로 불통과
  const early = await runMacro('2026-09-23T00:59:00Z', 60000);
  assert.ok(!early.includes('upbit-quote'));
});

test('check-price-alerts: 텔레그램 전송 실패면 발동 기록을 되돌려 다음 실행에 다시 보낸다', async () => {
  const alerts = [
    { id: 1, symbol: 'AAPL', kind: 'pct', direction: 'below', threshold: -1, last_fired_session: '2026-09-24', enabled: true },
    { id: 2, symbol: 'BTC_KRW', kind: 'price', direction: 'above', threshold: 100, last_fired_session: null, enabled: true },
  ];
  const quotes = [
    { symbol: 'AAPL', price: 100, percent_change: -5, fetched_at: '2026-09-25T19:59:00Z' },
    { symbol: 'BTC_KRW', price: 150, percent_change: 0.5, fetched_at: '2026-09-26T02:45:00Z' },
  ];
  const r = await runAlerts({ now: WEEKEND, alerts, quotes, telegramFails: true });
  assert.deepEqual(r.body.fired, []);
  assert.deepEqual(r.body.failed.sort(), ['AAPL(pct)', 'BTC_KRW(price)']);
  assert.equal(r.alerts[0].last_fired_session, '2026-09-24'); // 이전 값으로 복구
  assert.equal(r.alerts[1].enabled, true); // 목표가 알림 다시 켜짐
  const again = await runAlerts({ now: WEEKEND, alerts, quotes });
  assert.deepEqual(again.body.fired.sort(), ['AAPL(pct)', 'BTC_KRW(price)']);
});

test('check-price-alerts: 정지 전 옛 시세로는 발동하지 않는다(등락률은 지금 세션, 목표가는 5일 이내)', async () => {
  const alerts = [
    { id: 1, symbol: 'AAPL', kind: 'pct', direction: 'below', threshold: -1, last_fired_session: null, enabled: true },
    { id: 2, symbol: '005930.KS', kind: 'price', direction: 'above', threshold: 1, last_fired_session: null, enabled: true },
    { id: 3, symbol: 'KOSPI', kind: 'pct', direction: 'above', threshold: 1, last_fired_session: null, enabled: true },
  ];
  const quotes = [
    { symbol: 'AAPL', price: 100, percent_change: -5, fetched_at: '2026-09-21T19:59:00Z' }, // 지난 세션(뉴욕 9/21)
    { symbol: '005930.KS', price: 70000, percent_change: 1, fetched_at: '2026-08-03T06:20:00Z' }, // 정지 전
    { symbol: 'KOSPI', price: 3000, percent_change: 2, fetched_at: '2026-09-23T00:55:00Z' }, // 지금 세션
  ];
  const r = await runAlerts({ now: KR_OPEN, alerts, quotes });
  assert.deepEqual(r.body.fired, ['KOSPI(pct)']);
  assert.equal(r.alerts[1].enabled, true);
});

test('check-price-alerts: 되돌리기 저장이 한 번 실패해도 재시도로 복구하고, 계속 실패하면 revertFailed로 알린다', async () => {
  const mk = () => ({
    alerts: [
      { id: 1, symbol: 'AAPL', kind: 'pct', direction: 'below', threshold: -1, last_fired_session: null, enabled: true },
      { id: 2, symbol: 'BTC_KRW', kind: 'price', direction: 'above', threshold: 100, last_fired_session: null, enabled: true },
    ],
    quotes: [
      { symbol: 'AAPL', price: 100, percent_change: -5, fetched_at: '2026-09-25T19:59:00Z' },
      { symbol: 'BTC_KRW', price: 150, percent_change: 0.5, fetched_at: '2026-09-26T02:45:00Z' },
    ],
  });
  const once = await runAlerts({ now: WEEKEND, ...mk(), telegramFails: true, revertErrors: 1 });
  assert.equal(once.body.revertFailed, undefined);
  assert.equal(once.alerts[0].last_fired_session, null);
  assert.equal(once.alerts[1].enabled, true);
  const down = await runAlerts({ now: WEEKEND, ...mk(), telegramFails: true, revertErrors: 99 });
  assert.deepEqual(down.body.revertFailed.sort(), ['AAPL(pct)', 'BTC_KRW(price)']);
});