-- Tier 0 is an absorbing quarantine state for generic prose rows.  The shared
-- agent policies deliberately retain migration 018's exact role list while
-- adding the missing lower bound; tier-0 financial/health table revokes and
-- every grant remain unchanged.
do $$
declare t text;
begin
  foreach t in array array[
    'journal_entries','interactions','email_meta','pages','chunks',
    'tasks','goals','values_items','principles','decisions','commitments',
    'people','calendar_events','inbox_items','edges','orgs',
    'decision_transcripts','decision_branches'
  ]
  loop
    execute format(
      'alter policy tier_read on %I to minime_app, minime_engineer_ro using (tier >= 1 and tier <= app_allowed_tier())',
      t
    );
  end loop;
end $$;
