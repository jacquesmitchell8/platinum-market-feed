-- Allow browser (anon) to read crypto history tables — same pattern as metal_price_history.

drop policy if exists "Public read crypto history" on crypto_price_history;
drop policy if exists "Public read crypto history monthly" on crypto_price_history_monthly;

create policy "Public read crypto history"
  on crypto_price_history for select
  to anon, authenticated
  using (true);

create policy "Public read crypto history monthly"
  on crypto_price_history_monthly for select
  to anon, authenticated
  using (true);
