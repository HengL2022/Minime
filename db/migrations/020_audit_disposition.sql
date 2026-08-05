create unique index events_tool_disposition_result_event_uidx
  on events ((payload->>'result_event_id'))
  where verb like 'tool:%:disposition'
    and payload ? 'result_event_id';

create index events_get_context_released_disposition_idx
  on events ((payload->>'result_event_id'))
  where verb = 'tool:minime_get_context:disposition'
    and payload->>'status' = 'released';
