-- DB-backed blocking check: no in-memory timers; survives restarts.
-- blocking_check_at = when to consider execution blocked if no further activity (set to now() + 3 min on each blocking-activity event).
-- blocking_payload = last hook payload for push notification content (jsonb).
alter table public.agent_executions
  add column if not exists blocking_check_at timestamptz,
  add column if not exists blocking_payload jsonb;

comment on column public.agent_executions.blocking_check_at is 'When to run blocking check (now + 3 min on activity); null = no pending check';
comment on column public.agent_executions.blocking_payload is 'Last hook payload for agentBlocked push content';

create index if not exists idx_agent_executions_blocking_check_at
  on public.agent_executions (blocking_check_at)
  where blocking_check_at is not null and status in ('running', 'blocked');
