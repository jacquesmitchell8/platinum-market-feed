-- Run once in Supabase SQL editor if ta_pattern_library / ta_observations missing.

create table if not exists ta_pattern_library (
  slug text primary key,
  title text not null,
  bias text,
  summary text,
  theory text,
  diagram text,
  updated_at timestamptz default now()
);

create table if not exists ta_observations (
  id bigserial primary key,
  pattern_slug text not null references ta_pattern_library(slug),
  curve_id text,
  timeframe text,
  fingerprint text not null,
  event_start_ts timestamptz,
  event_end_ts timestamptz,
  price_snapshot jsonb,
  story_narrative text,
  story_sources jsonb default '[]'::jsonb,
  detected_at timestamptz default now(),
  unique (fingerprint)
);

create index if not exists ta_observations_curve_tf
  on ta_observations (curve_id, timeframe, detected_at desc);

alter table ta_pattern_library enable row level security;
alter table ta_observations enable row level security;

drop policy if exists "Public read ta patterns" on ta_pattern_library;
drop policy if exists "Public read ta observations" on ta_observations;

create policy "Public read ta patterns"
  on ta_pattern_library for select to anon, authenticated using (true);

create policy "Public read ta observations"
  on ta_observations for select to anon, authenticated using (true);
