-- Calendar occurrence expansion (livability program, W3-2): RRULE/RDATE/EXDATE recurring events
-- previously imported only their DTSTART as a single row -- a weekly standup showed up once,
-- not every week. calendar_events now keys identity on (uid, occurrence_start) instead of uid
-- alone, so each expanded occurrence is its own row while the importer stays idempotent.
--
-- Numbered 031: the task's own spec text targeted migration 028, already taken by
-- 028_correction_supersede.sql; the program's reassignment (030) was ALSO taken in the interim
-- by 030_task_recurrence.sql (W3-1, landed on this branch first). 031 is the true next free
-- number as of this migration -- noted here since it is a numbering deviation from the task's
-- own spec, not because renumbering itself is a contract decision (same convention as 030's own
-- migration-comment precedent).

alter table calendar_events add column occurrence_start timestamptz;
update calendar_events set occurrence_start = starts_at where occurrence_start is null;
alter table calendar_events alter column occurrence_start set not null;

alter table calendar_events drop constraint calendar_events_uid_key;
alter table calendar_events
  add constraint calendar_events_uid_occurrence_start_key unique (uid, occurrence_start);

-- Pruning a changed RRULE's stale FUTURE occurrences (repo.deleteCalendarOccurrencesNotIn) needs
-- DELETE on this table, which minime_app never had. Mirror the exact chunks/edges tier_delete
-- precedent from 021_runtime_app_role.sql -- same grant shape, same tier-bounded USING clause.
grant delete on calendar_events to minime_app;
drop policy if exists tier_delete on calendar_events;
create policy tier_delete on calendar_events for delete to minime_app
  using (tier >= 1 and tier <= app_allowed_tier());
