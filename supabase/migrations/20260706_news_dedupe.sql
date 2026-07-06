-- News dedupe + metadata columns for ingest pipeline

alter table news_stories add column if not exists topic text;
alter table news_stories add column if not exists fetched_at timestamptz;

-- Normalized title for dedupe when Google News URLs differ per feed
alter table news_stories add column if not exists title_norm text;

update news_stories
set title_norm = lower(
  regexp_replace(
    regexp_replace(
      regexp_replace(coalesce(title, ''), '\s+by\s+[a-z0-9][\w\s.&''-]*$', '', 'i'),
      '\s+-\s+[^-]+$', '', 'g'
    ),
    '[^\w\s]', ' ', 'g'
  )
)
where title_norm is null;

-- Remove exact URL duplicates (keep newest)
delete from news_stories a
using news_stories b
where a.id < b.id
  and a.url is not null
  and b.url is not null
  and lower(trim(a.url)) = lower(trim(b.url));

-- Remove near-duplicate titles (same normalized prefix)
delete from news_stories a
using news_stories b
where a.id < b.id
  and a.title_norm is not null
  and b.title_norm is not null
  and left(a.title_norm, 72) = left(b.title_norm, 72);

create unique index if not exists news_stories_url_unique
  on news_stories (url)
  where url is not null and trim(url) <> '';

create index if not exists news_stories_title_norm_idx
  on news_stories (left(title_norm, 72));

create index if not exists news_stories_published_idx
  on news_stories (published_at desc nulls last);
