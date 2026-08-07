-- Legacy inbox rows have no durable byte identity. Keep the new identity columns nullable so
-- migration never guesses from mutable raw paths; the watcher adopts an eligible legacy row only
-- when it sees the bytes again.
alter table inbox_items
  add column content_hash text,
  add column archive_path text,
  add column claim_token uuid,
  add column claimed_at timestamptz;

alter table inbox_items drop constraint inbox_items_status_check;
alter table inbox_items
  add constraint inbox_items_status_check
    check (status in ('pending', 'processing', 'filed', 'rejected')),
  add constraint inbox_items_content_hash_sha256_check
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  add constraint inbox_items_archive_path_relative_check
    check (archive_path is null or archive_path ~ '^archive/[0-9]{4}/[0-9]{2}/[A-Za-z0-9._-]+$'),
  add constraint inbox_items_processing_claim_check
    check (
      (status = 'processing' and claim_token is not null and claimed_at is not null)
      or
      (status <> 'processing' and claim_token is null and claimed_at is null)
    ),
  add constraint inbox_items_archive_path_key unique (archive_path);

create unique index inbox_items_raw_path_content_hash_uidx
  on inbox_items (raw_path, content_hash)
  where content_hash is not null;

-- raw_path identifies the capture source and is never mutable. Hash/archive fields are write-once:
-- NULL -> value supports lazy legacy adoption and post-claim archive publication, after which the
-- row remains bound to the exact captured bytes and immutable archive. A terminal legacy row cannot
-- truthfully acquire a byte identity after the fact, so the first bytes observed after upgrade are
-- preserved as a separate new capture rather than assigned to that historical row.
create or replace function enforce_inbox_capture_identity_immutable() returns trigger as $$
begin
  if new.raw_path is distinct from old.raw_path
    or (old.content_hash is not null and new.content_hash is distinct from old.content_hash)
    or (old.archive_path is not null and new.archive_path is distinct from old.archive_path)
  then
    raise exception 'inbox_capture_identity_immutable';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger inbox_capture_identity_immutable
  before update on inbox_items
  for each row execute function enforce_inbox_capture_identity_immutable();
