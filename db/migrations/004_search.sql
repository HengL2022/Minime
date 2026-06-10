create table chunks (
  id uuid primary key default gen_random_uuid(),
  parent_type text not null,            -- 'page' | 'journal' | 'interaction' | 'decision' | …
  parent_id uuid not null,
  ord int not null,
  text text not null,
  tier smallint not null,
  embed_model text,
  embedding vector(768),
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  updated_at timestamptz not null default now(),
  unique (parent_type, parent_id, ord)
);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_vec_idx on chunks using hnsw (embedding vector_cosine_ops);
