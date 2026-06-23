-- Platinum Metis — Supabase schema
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
--
-- Works on a fresh project OR if you already have tables from an earlier run.
-- Order matters: add columns before creating indexes on them.

-- ─── 1. Base tables (no recorded_day yet — safe if tables already exist) ───

create table if not exists market_snapshots (
  snapshot_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  source text
);

create table if not exists metal_price_history (
  id bigserial primary key,
  asset text not null,
  price numeric not null,
  recorded_at timestamptz not null
);

create table if not exists crypto_price_history (
  id bigserial primary key,
  asset text not null,
  price numeric not null,
  recorded_at timestamptz not null
);

create table if not exists producer_price_history (
  id bigserial primary key,
  ticker text not null,
  price numeric not null,
  recorded_at timestamptz not null
);

create table if not exists producer_quotes (
  ticker text primary key,
  name text,
  price numeric,
  currency text,
  change_pct numeric,
  updated_at timestamptz,
  source text
);

create table if not exists news_stories (
  id bigserial primary key,
  title text not null,
  url text,
  source text,
  published_at timestamptz,
  created_at timestamptz default now()
);

-- ─── 2. Add recorded_day (dedupe key — avoids timestamptz::date index error) ─

alter table metal_price_history add column if not exists recorded_day date;
alter table crypto_price_history add column if not exists recorded_day date;
alter table producer_price_history add column if not exists recorded_day date;

update metal_price_history
  set recorded_day = (recorded_at at time zone 'utc')::date
  where recorded_day is null;

update crypto_price_history
  set recorded_day = (recorded_at at time zone 'utc')::date
  where recorded_day is null;

update producer_price_history
  set recorded_day = (recorded_at at time zone 'utc')::date
  where recorded_day is null;

alter table metal_price_history alter column recorded_day set not null;
alter table crypto_price_history alter column recorded_day set not null;
alter table producer_price_history alter column recorded_day set not null;

-- ─── 3. Indexes (drop old broken ones first) ───────────────────────────────

drop index if exists metal_price_history_asset_day;
drop index if exists crypto_price_history_asset_day;
drop index if exists producer_price_history_ticker_day;

create unique index if not exists metal_price_history_asset_day
  on metal_price_history (asset, recorded_day);

create index if not exists metal_price_history_asset_recorded
  on metal_price_history (asset, recorded_at);

create unique index if not exists crypto_price_history_asset_day
  on crypto_price_history (asset, recorded_day);

create index if not exists crypto_price_history_asset_recorded
  on crypto_price_history (asset, recorded_at);

create unique index if not exists producer_price_history_ticker_day
  on producer_price_history (ticker, recorded_day);

create index if not exists producer_price_history_ticker_recorded
  on producer_price_history (ticker, recorded_at);

-- ─── 4. Row Level Security ─────────────────────────────────────────────────
-- service_role (Netlify) bypasses RLS and can read/write everything.
-- anon key (browser) can only read public market data — never write.

alter table market_snapshots enable row level security;
alter table metal_price_history enable row level security;
alter table crypto_price_history enable row level security;
alter table producer_price_history enable row level security;
alter table producer_quotes enable row level security;
alter table news_stories enable row level security;

drop policy if exists "Public read market snapshots" on market_snapshots;
drop policy if exists "Public read metal history" on metal_price_history;
drop policy if exists "Public read news" on news_stories;

create policy "Public read market snapshots"
  on market_snapshots for select
  to anon, authenticated
  using (true);

create policy "Public read metal history"
  on metal_price_history for select
  to anon, authenticated
  using (true);

create policy "Public read news"
  on news_stories for select
  to anon, authenticated
  using (true);
