-- 캔들차트용 일별 OHLCV 저장 테이블.
-- quote_history는 장중 스냅샷(종가 1값)만 담아 캔들(시가/고가/저가/종가+거래량)을 못 그림.
-- 일봉 캔들 데이터는 야후·KIS 일봉 API가 하루당 OHLCV를 깔끔히 주므로 별도 테이블에 하루 1행으로 저장.
create table if not exists daily_ohlc (
  symbol text not null,
  date date not null,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume numeric,
  percent_change numeric,
  primary key (symbol, date)
);

create index if not exists daily_ohlc_symbol_date_idx
  on daily_ohlc (symbol, date desc);
