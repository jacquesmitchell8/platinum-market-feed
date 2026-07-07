-- Producer intraday time-series (hourly bars) for JSE miners.
-- Enables informative 24h/1w/1m charts without Yahoo/browser scraping.

create table if not exists producer_price_intraday (
  id bigserial primary key,
  ticker text not null,
  interval_min int not null default 60,
  recorded_at timestamptz not null,
  open numeric,
  high numeric,
  low numeric,
  close numeric not null,
  volume numeric,
  source text
);

create unique index if not exists producer_price_intraday_ticker_interval_ts
  on producer_price_intraday (ticker, interval_min, recorded_at);

create index if not exists producer_price_intraday_ticker_ts
  on producer_price_intraday (ticker, recorded_at desc);

alter table producer_price_intraday enable row level security;

drop policy if exists "Public read producer intraday" on producer_price_intraday;
create policy "Public read producer intraday"
  on producer_price_intraday for select
  to anon, authenticated
  using (true);

