-- Allow the browser (anon key) to read producer curves + latest quotes.
-- Needed because index.html reads Supabase directly for the Producers tab.

alter table producer_price_history enable row level security;
alter table producer_quotes enable row level security;

drop policy if exists "Public read producer history" on producer_price_history;
create policy "Public read producer history"
  on producer_price_history for select
  to anon, authenticated
  using (true);

drop policy if exists "Public read producer quotes" on producer_quotes;
create policy "Public read producer quotes"
  on producer_quotes for select
  to anon, authenticated
  using (true);

