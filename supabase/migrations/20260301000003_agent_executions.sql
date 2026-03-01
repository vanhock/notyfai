-- Agent executions: one per generation_id (agent run / user message turn)
create table if not exists public.agent_executions (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.cursor_instances(id) on delete cascade,
  generation_id text not null,
  conversation_id text,
  status text not null default 'running', -- running | blocked | stopped
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instance_id, generation_id)
);

create index if not exists idx_agent_executions_instance_started
  on public.agent_executions (instance_id, started_at desc);

-- RLS
alter table public.agent_executions enable row level security;

create policy "agent_executions_select_own"
  on public.agent_executions for select
  using (
    exists (
      select 1 from public.cursor_instances ci
      where ci.id = agent_executions.instance_id and ci.user_id = auth.uid()
    )
  );

create policy "agent_executions_delete_own"
  on public.agent_executions for delete
  using (
    exists (
      select 1 from public.cursor_instances ci
      where ci.id = agent_executions.instance_id and ci.user_id = auth.uid()
    )
  );

-- Extend cursor_events with execution reference and semantic type
alter table public.cursor_events
  add column if not exists execution_id uuid references public.agent_executions(id) on delete set null,
  add column if not exists semantic_type text;

create index if not exists idx_cursor_events_execution
  on public.cursor_events (execution_id, created_at asc);
