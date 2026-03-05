-- Threads: one row per Cursor conversation (session_id = conversation_id).
-- Eliminates duplication: one status per thread; agent_executions reference thread_id.
create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.cursor_instances(id) on delete cascade,
  conversation_id text not null unique,
  status text not null default 'pending',
  prompt text,
  session_ended_at timestamptz,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_threads_instance_updated
  on public.threads (instance_id, updated_at desc);

-- RLS: same pattern as agent_executions
alter table public.threads enable row level security;

create policy "threads_select_own"
  on public.threads for select
  using (
    exists (
      select 1 from public.cursor_instances ci
      where ci.id = threads.instance_id and ci.user_id = auth.uid()
    )
  );

create policy "threads_delete_own"
  on public.threads for delete
  using (
    exists (
      select 1 from public.cursor_instances ci
      where ci.id = threads.instance_id and ci.user_id = auth.uid()
    )
  );

-- Realtime: enable for threads so the app can subscribe to thread changes
alter publication supabase_realtime add table public.threads;
