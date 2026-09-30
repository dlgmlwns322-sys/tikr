import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

// tikr-collect 순수 로직(logic.ts)을 타입만 지워 그대로 불러온다.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = stripTypeScriptTypes(readFileSync(join(root, 'supabase/functions/tikr-collect/logic.ts'), 'utf8'));
const L = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const at = (iso) => new Date(iso);

test('확정 세션 날짜: 마감 + 30분 전이면 전 평일(미 16:30 ET · 한 16:00 KST, 서머타임 포함)', () => {
  assert.equal(L.lastSession(at('2026-09-29T21:35:00Z'), 'US'), '2026-09-29');   // 화 17:35 EDT
  assert.equal(L.lastSession(at('2026-09-29T20:29:00Z'), 'US'), '2026-09-28');   // 화 16:29 EDT
  assert.equal(L.lastSession(at('2026-12-01T21:30:00Z'), 'US'), '2026-12-01');   // 화 16:30 EST(= 수 06:30 KST)
  assert.equal(L.lastSession(at('2026-12-01T21:29:00Z'), 'US'), '2026-11-30');
  assert.equal(L.lastSession(at('2026-10-03T12:00:00Z'), 'US'), '2026-10-02');   // 토 → 금
  assert.equal(L.lastSession(at('2026-09-29T07:00:00Z'), 'KR'), '2026-09-29');   // 16:00 KST
  assert.equal(L.lastSession(at('2026-09-29T06:59:00Z'), 'KR'), '2026-09-28');
  assert.equal(L.lastSession(at('2026-10-04T21:35:00Z'), 'KR'), '2026-10-02');   // 월 06:35 KST → 금
});

test('미완성 봉 제외: 현지 오늘 봉은 마감 + 30분 전이면 버리고, 미래 날짜는 항상 버린다', () => {
  const rows = [{ d: '2026-09-28' }, { d: '2026-09-29' }, { d: '2026-09-30' }];
  assert.deepEqual(L.dropIncomplete(rows, at('2026-09-29T17:47:00Z'), 'US').map((r) => r.d), ['2026-09-28']);   // 13:47 ET
  assert.deepEqual(L.dropIncomplete(rows, at('2026-09-29T20:30:00Z'), 'US').map((r) => r.d), ['2026-09-28', '2026-09-29']);
  assert.deepEqual(L.dropIncomplete(rows, at('2026-09-30T06:59:00Z'), 'KR').map((r) => r.d), ['2026-09-28', '2026-09-29']);
  assert.deepEqual(L.dropIncomplete(rows, at('2026-09-30T07:00:00Z'), 'KR').map((r) => r.d), ['2026-09-28', '2026-09-29', '2026-09-30']);
});

test('KIS 응답 파싱: 빈 칸·잘못된 날짜·0 이하 가격은 버리고, 거래량 빈 칸은 결측, 날짜 오름차순·중복 제거', () => {
  const us = L.parseUsDaily([
    { xymd: '20260929', clos: '254.4300', tvol: '41234567', tamt: '10498765432' },
    { xymd: '', clos: '', tvol: '', tamt: '' },
    { xymd: '20260926', clos: '250.0000', tvol: '', tamt: '0' },
    { xymd: '20260231', clos: '1', tvol: '1', tamt: '1' },
    { xymd: '20260925', clos: '0', tvol: '1', tamt: '1' },
    { xymd: '20260929', clos: '254.4300', tvol: '41234567', tamt: '10498765432' },
  ]);
  assert.deepEqual(us, [
    { d: '2026-09-26', close: 250, volume: null, amount: 0 },
    { d: '2026-09-29', close: 254.43, volume: 41234567, amount: 10498765432 },
  ]);
  assert.deepEqual(L.parseKrDaily([{ stck_bsop_date: '20260929', stck_clpr: '71500', acml_vol: '0', acml_tr_pbmn: '-5' }]),
    [{ d: '2026-09-29', close: 71500, volume: 0, amount: null }]);
  assert.deepEqual(L.parseOverseasChart([{ stck_bsop_date: '20260929', ovrs_nmix_prpr: '18123.45' }]), [{ d: '2026-09-29', v: 18123.45 }]);
  assert.deepEqual(L.parseKrIndex(null), []);
});

test('겹침 창: 25일 창을 20일씩 옮기고, 최근 날짜가 창 경계에 오지 않으며 과거 구간을 빠짐없이 덮는다', () => {
  const T = '2026-09-30';
  const ws = L.seriesWindows(T);
  assert.deepEqual(ws, [
    { from: '2026-09-10', to: '2026-10-04' }, { from: '2026-08-21', to: '2026-09-14' }, { from: '2026-08-01', to: '2026-08-25' },
  ]);
  for (let k = 0; k <= 58; k++) {
    const d = L.addDays(T, -k);
    assert.ok(ws.some((w) => w.from < d && d < w.to), `${d}는 어떤 창의 안쪽에 있어야 함`);
  }
  const bf = L.seriesWindows(T, '2025-06-01');
  assert.ok(bf.at(-1).from < '2025-06-01' && bf.every((w, i) => i === 0 || L.addDays(bf[i - 1].from, 4) === w.to));
});

test('겹침 병합: 같은 날짜 값이 같으면 채택(소수 8자리), 다르면 충돌', () => {
  const r = L.mergeSeries([
    [{ d: '2026-09-28', v: 100 }, { d: '2026-09-29', v: 101 }],
    [{ d: '2026-09-29', v: 101.000000001 }, { d: '2026-09-30', v: 102 }],
    [{ d: '2026-09-30', v: 103 }],
  ]);
  assert.deepEqual(r.rows, [{ d: '2026-09-28', v: 100 }, { d: '2026-09-29', v: 101 }]);
  assert.deepEqual(r.conflicts, [{ d: '2026-09-30', vals: [102, 103] }]);
});

test('Finnhub 같은 거래일 값: 마감 뒤 c(정규장 종가), 다음 세션이면 pc, 날짜가 안 맞거나 시간외면 비교 보류', () => {
  const close929 = Date.parse('2026-09-29T20:00:00Z') / 1000;   // 16:00 EDT
  assert.deepEqual(L.finnhubSameDay({ c: 254.43, pc: 250, t: close929 }, '2026-09-29'), { price: 254.43, field: 'c', date: '2026-09-29' });
  assert.equal(L.finnhubSameDay({ c: 255, pc: 250, t: Date.parse('2026-09-29T23:30:00Z') / 1000 }, '2026-09-29'), null);   // 19:30 ET 시간외
  assert.deepEqual(L.finnhubSameDay({ c: 256, pc: 254.43, t: Date.parse('2026-09-30T14:00:00Z') / 1000 }, '2026-09-29'),
    { price: 254.43, field: 'pc', date: '2026-09-29' });
  assert.deepEqual(L.finnhubSameDay({ c: 1, pc: 250, t: Date.parse('2026-10-05T17:00:00Z') / 1000 }, '2026-10-02'),
    { price: 250, field: 'pc', date: '2026-10-02' });   // 금 → 월
  assert.equal(L.finnhubSameDay({ c: 1, pc: 2, t: Date.parse('2026-10-01T17:00:00Z') / 1000 }, '2026-09-29'), null);   // 이틀 뒤
  assert.equal(L.finnhubSameDay({ c: 1, pc: 2, t: Date.parse('2026-09-28T20:00:00Z') / 1000 }, '2026-09-29'), null);   // 전날
  assert.equal(L.finnhubSameDay({ c: 0, pc: 0, t: 0 }, '2026-09-29'), null);   // 모르는 종목
});

test('2출처 대조(ref price_2source): |KIS ÷ Finnhub − 1| ≤ 0.5%면 일치', () => {
  assert.equal(L.price2Source(100.4, 100).ok, true);
  assert.equal(L.price2Source(99.39, 100).ok, false);
  assert.equal(L.price2Source(254.43, 254.43).diff, 0);
});

test('재무 매핑: 시총은 Finnhub USD 우선·비USD만 KIS 대체, PER 이력은 최신 분기부터 20개, 한국은 억원·% 환산', () => {
  assert.deepEqual(L.marketCapUsd(2500, 'USD', 9e11, 'USD'), { cap: 2.5e9, source: 'Finnhub' });
  assert.deepEqual(L.marketCapUsd(null, 'USD', 9e11, 'USD'), { cap: null, source: null });
  assert.deepEqual(L.marketCapUsd(4e7, 'TWD', 9e11, 'USD'), { cap: 9e11, source: 'KIS 대체(비USD 보고 · 상장 주식 기준)' });
  assert.deepEqual(L.marketCapUsd(4e7, null, 9e11, 'USD'), { cap: null, source: null });

  const series = Array.from({ length: 25 }, (_, i) => ({ period: L.addDays('2020-03-31', i * 91), v: i }));   // 오래된 분기부터(정렬 필요)
  const us = L.usFund('AAPL', '2026-10-02', {
    metric: { epsTTM: -1.2, revenueGrowthTTMYoy: 5, 'totalDebt/totalEquityQuarterly': 1.5, roeTTM: 30, bookValuePerShareQuarterly: -3,
              peTTM: 31, marketCapitalization: 3e6 },
    series: { quarterly: { peTTM: series } },
  }, 'USD');
  assert.equal(us.eps_ttm, -1.2);
  assert.equal(us.equity_positive, false);
  assert.equal(us.market_cap_usd, 3e12);
  assert.deepEqual(us.pe_hist, Array.from({ length: 20 }, (_, i) => 24 - i));   // 최신 분기(v=24)부터 20개

  const kr = L.krFund('005930', '2026-10-02', { eps: '4950', per: '14.4', bps: '57000', hts_avls: '4250000' },
    [{ stac_yymm: '202506', grs: '7.1', roe_val: '9.0', lblt_rate: '27.5' }, { stac_yymm: '202412', grs: '16.2', roe_val: '8.6', lblt_rate: '26.4' }]);
  assert.deepEqual([kr.rev_growth, kr.roe, kr.debt_ratio_x, kr.market_cap_krw, kr.equity_positive, kr.pe_now],
    [7.1, 9, 0.275, 4.25e14, true, 14.4]);
});
