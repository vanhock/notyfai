-- Group executions by Cursor agent session (sessionStart/sessionEnd, session_id).
-- session_id = conversation_id from Cursor; one session = one composer conversation.
alter table public.agent_executions
  add column if not exists session_id text,
  add column if not exists session_ended_at timestamptz;

comment on column public.agent_executions.session_id is 'Cursor session_id (same as conversation_id); groups all turns in one composer conversation';
comment on column public.agent_executions.session_ended_at is 'Set when sessionEnd hook fires for this session';

-- Backfill: conversation_id is the session identifier
update public.agent_executions
  set session_id = conversation_id
  where conversation_id is not null and session_id is null;

create index if not exists idx_agent_executions_instance_session
  on public.agent_executions (instance_id, session_id);
