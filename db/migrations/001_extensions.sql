create extension if not exists vector;
create extension if not exists pgcrypto;

-- updated_at maintenance trigger, attached to every substantive table in later migrations.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;
