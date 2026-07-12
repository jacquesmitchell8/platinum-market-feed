-- Historical dealer asks from Face Value Scarcity OCR uploads.
-- Permanent archive; UI shows last 7 days by default and can recall all.

create table if not exists face_coin_quotes (
  id text primary key,
  recorded_at timestamptz not null default now(),
  seller text,
  coin text not null,
  value_aud numeric,
  melt_aud numeric,
  premium_pct numeric,
  recommendation text,
  scarcity_score integer,
  metal text,
  weight_oz numeric,
  source_file text,
  batch_id text,
  reasoning text
);

create index if not exists face_coin_quotes_recorded_idx
  on face_coin_quotes (recorded_at desc);

create index if not exists face_coin_quotes_coin_idx
  on face_coin_quotes (coin);

alter table face_coin_quotes enable row level security;

-- Public read for dashboard (anon key). Writes go through Netlify service role.
drop policy if exists face_coin_quotes_public_read on face_coin_quotes;
create policy face_coin_quotes_public_read
  on face_coin_quotes for select
  to anon, authenticated
  using (true);
