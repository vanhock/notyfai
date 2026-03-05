-- Add thread_id to agent_executions (nullable for backfill)
alter table public.agent_executions
  add column if not exists thread_id uuid references public.threads(id) on delete cascade;

-- Create threads from distinct (instance_id, session_key)
-- Non-orphans: session_key = COALESCE(session_id, conversation_id)
insert into public.threads (instance_id, conversation_id, status, prompt, session_ended_at, started_at, updated_at)
select
  instance_id,
  session_key as conversation_id,
  (array_agg(status order by
    case status
      when 'stopped' then 4
      when 'blocked' then 3
      when 'running' then 2
      when 'pending' then 1
      else 0
    end desc, updated_at desc
  ))[1] as status,
  (array_agg(prompt order by started_at asc) filter (where prompt is not null))[1] as prompt,
  max(session_ended_at) as session_ended_at,
  min(started_at) as started_at,
  max(updated_at) as updated_at
from (
  select *,
    coalesce(session_id, conversation_id) as session_key
  from public.agent_executions
  where coalesce(session_id, conversation_id) is not null
) sub
group by instance_id, session_key
on conflict (conversation_id) do update set
  status = excluded.status,
  prompt = coalesce(threads.prompt, excluded.prompt),
  session_ended_at = coalesce(threads.session_ended_at, excluded.session_ended_at),
  started_at = least(threads.started_at, excluded.started_at),
  updated_at = greatest(threads.updated_at, excluded.updated_at);

-- Orphans: one thread per execution with no session_id/conversation_id
insert into public.threads (instance_id, conversation_id, status, prompt, session_ended_at, started_at, updated_at)
select
  instance_id,
  'orphan-' || id::text as conversation_id,
  status,
  prompt,
  session_ended_at,
  started_at,
  updated_at
from public.agent_executions
where session_id is null and conversation_id is null
on conflict (conversation_id) do nothing;

-- Backfill thread_id on agent_executions (non-orphans)
update public.agent_executions e
set thread_id = t.id
from public.threads t
where e.instance_id = t.instance_id
  and t.conversation_id = coalesce(e.session_id, e.conversation_id)
  and coalesce(e.session_id, e.conversation_id) is not null;

-- Backfill thread_id for orphans
update public.agent_executions e
set thread_id = t.id
from public.threads t
where e.instance_id = t.instance_id
  and t.conversation_id = 'orphan-' || e.id::text
  and e.session_id is null
  and e.conversation_id is null;

-- Make thread_id required
alter table public.agent_executions
  alter column thread_id set not null;

-- Replace unique constraint: (thread_id, generation_id) instead of (instance_id, generation_id)
alter table public.agent_executions
  drop constraint if exists agent_executions_instance_id_generation_id_key;

create unique index if not exists agent_executions_thread_generation_key
  on public.agent_executions (thread_id, generation_id);

-- Drop blocking_check_at partial index before dropping status (index references status)
drop index if exists public.idx_agent_executions_blocking_check_at;

-- Drop columns moved to threads
alter table public.agent_executions
  drop column if exists conversation_id,
  drop column if exists session_id,
  drop column if exists status,
  drop column if exists prompt,
  drop column if exists session_ended_at,
  drop column if exists model,
  drop column if exists workspace_roots;

-- Recreate blocking_check_at index (without status filter; worker will join threads)
create index if not exists idx_agent_executions_blocking_check_at
  on public.agent_executions (blocking_check_at)
  where blocking_check_at is not null;
