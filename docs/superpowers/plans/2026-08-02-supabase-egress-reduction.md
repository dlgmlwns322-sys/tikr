# 티커 Supabase 사용량 추가 절감 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 티커가 실제 사용하는 `BTC_KRW`만 15분 간격으로 저장하고 프론트의 Supabase 응답량을 줄인다.

**Architecture:** 기존 `macro-poll` 5분 크론과 함수 구조를 유지하되 업비트 호출만 분 단위 게이트로 15분마다 실행한다. 바이낸스 호출과 미사용 코인 저장을 중단하고, 프론트 쿼리는 필요한 필드와 500행 상한만 사용한다.

**Tech Stack:** Deno Edge Functions, Supabase JS, vanilla JavaScript, Node.js `node:test`

## Global Constraints

- 기존 ETH·XRP·USDT 데이터와 Edge Function은 삭제하지 않는다.
- 한국장 KIS 5분 수집, 장외 게이팅, 프루닝은 유지한다.
- 새 의존성·테이블·RPC를 추가하지 않는다.
- 비밀키를 테스트·로그·Git에 기록하지 않는다.

---

### Task 1: 사용량 예산 회귀 테스트

**Files:**
- Create: `test/egress-budget.test.mjs`
- Test: `test/egress-budget.test.mjs`

**Interfaces:**
- Consumes: `macro-poll/index.ts`, `upbit-quote/index.ts`, `index.html`의 소스 텍스트
- Produces: 수집 대상·주기·조회 필드를 고정하는 정적 회귀 테스트

- [ ] Node `node:test`, `assert/strict`, `fs.readFileSync`로 다음을 검사하는 테스트를 작성한다.
  - `macro-poll`에 `binance-quote`가 없어야 한다.
  - 업비트 호출은 `minute % 15 === 0` 조건 안에 있어야 한다.
  - `upbit-quote`의 `MARKETS`는 `KRW-BTC` 하나여야 한다.
  - 홈 당일 쿼리는 `price,percent_change,fetched_at`만 선택해야 한다.
  - 차트 폴백은 `.limit(500)`이어야 하고 `.limit(2000)`은 없어야 한다.
- [ ] `node --test test/egress-budget.test.mjs`를 실행해 현재 코드에서 실패하는지 확인한다.

### Task 2: 24시간 수집 축소

**Files:**
- Modify: `supabase/functions/macro-poll/index.ts`
- Modify: `supabase/functions/upbit-quote/index.ts`
- Test: `test/egress-budget.test.mjs`

**Interfaces:**
- Consumes: 기존 5분 `macro-poll` 크론
- Produces: KIS·환율은 기존 주기 유지, `BTC_KRW`만 15분마다 저장

- [ ] `MARKETS`를 `["KRW-BTC"]`로 줄인다.
- [ ] `macro-poll`에서 `binance-quote` 호출을 제거한다.
- [ ] 현재 KST 분이 0·15·30·45일 때만 `upbit-quote`를 호출한다.
- [ ] 테스트를 실행해 수집 관련 검사가 통과하는지 확인한다.

### Task 3: 프론트 REST 응답 축소

**Files:**
- Modify: `index.html`
- Test: `test/egress-budget.test.mjs`

**Interfaces:**
- Consumes: 기존 `periodQuote()`와 `loadChart()`
- Produces: 홈 당일 3필드×30행, 차트 폴백 최대 500행

- [ ] `periodQuote()` 당일 쿼리의 `select('*')`를 `select('price,percent_change,fetched_at')`로 바꾼다.
- [ ] `loadChart()` 폴백의 `.limit(2000)`을 `.limit(500)`으로 바꾼다.
- [ ] `node --test test/egress-budget.test.mjs`와 `git diff --check`를 실행한다.
- [ ] `index.html` 스크립트 문법을 `new Function` 방식으로 검사한다.

### Task 4: 배포·실환경 검증

**Files:**
- Deploy: `supabase/functions/macro-poll/index.ts`
- Deploy: `supabase/functions/upbit-quote/index.ts`

**Interfaces:**
- Consumes: Supabase project `rxaaouywglshpommdxnb`
- Produces: 배포된 15분 BTC 전용 수집

- [ ] `supabase functions deploy upbit-quote --project-ref rxaaouywglshpommdxnb --no-verify-jwt`를 실행한다.
- [ ] `supabase functions deploy macro-poll --project-ref rxaaouywglshpommdxnb --no-verify-jwt`를 실행한다.
- [ ] `macro-poll`을 실호출해 응답에 `binance-quote`가 없고 15분 경계 밖에서는 업비트가 호출되지 않는지 확인한다.
- [ ] DB 최신 행에서 자동 수집 대상이 `BTC_KRW` 하나로 줄었는지 다음 15분 경계 후 확인한다.
- [ ] 월요일 한국장·미국장 개장 후 `fetched_at` 재개 확인은 `_meta.md` 다음 할 일로 기록한다.

### Task 5: 기록·Git 마무리

**Files:**
- Modify: `Projects/주식분석-앱/_meta.md` in vault
- Commit: 티커 저장소 변경

**Interfaces:**
- Produces: 적용 결과·검증 수치·남은 월요일 검증 항목 기록

- [ ] 테스트·배포 결과와 남은 장중 검증을 `_meta.md`에 기록한다.
- [ ] 비밀정보와 의도하지 않은 미추적 파일이 포함되지 않았는지 확인한다.
- [ ] 의미 단위로 커밋하고 사용자 승인 후 GitHub에 push한다.