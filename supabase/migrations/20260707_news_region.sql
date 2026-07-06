-- News lenses: price (where spot is set) | supply (mine/JSE) | demand (Asia industrial)

alter table news_stories add column if not exists region text;

update news_stories set region = 'supply'
where region is null and (
  topic = 'producers'
  or lower(coalesce(source, '')) ~ 'moneyweb|biznews|mining weekly'
  or lower(title) ~ 'sibanye|impala|northam|implats|jse|eskom|bushveld|south africa'
);

update news_stories set region = 'demand'
where region is null and (
  topic = 'macro'
  or lower(coalesce(source, '')) ~ 'business times|nikkei|scmp|xinhua|global times|channel news|cna|caixin|asia financial'
  or lower(title) ~ 'china|singapore|japan|hydrogen|fuel cell|automotive'
);

update news_stories set region = 'price'
where region is null;

create index if not exists news_stories_region_published_idx
  on news_stories (region, published_at desc nulls last);
