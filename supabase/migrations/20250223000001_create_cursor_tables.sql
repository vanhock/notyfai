-- Cursor instances: one per user "device" / hook setup
create table if not exists public.cursor_instances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked boolean not null default false,
  name text,
  last_event_at timestamptz
);

-- Cursor events: streamed to app via Realtime
create table if not exists public.cursor_events (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.cursor_instances(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_cursor_events_instance_created
  on public.cursor_events (instance_id, created_at desc);

-- RLS
alter table public.cursor_instances enable row level security;
alter table public.cursor_events enable row level security;

-- cursor_instances: users can only see/insert/update their own
create policy "cursor_instances_select_own"
  on public.cursor_instances for select
  using (auth.uid() = user_id);

create policy "cursor_instances_insert_own"
  on public.cursor_instances for insert
  with check (auth.uid() = user_id);

create policy "cursor_instances_update_own"
  on public.cursor_instances for update
  using (auth.uid() = user_id);

-- cursor_events: users can only select events for their instances (no insert from client; backend uses service_role)
create policy "cursor_events_select_own"
  on public.cursor_events for select
  using (
    exists (
      select 1 from public.cursor_instances ci
      where ci.id = cursor_events.instance_id and ci.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for cursor_events for authenticated users; backend uses service_role to insert.

-- Realtime: enable for cursor_events so the app can subscribe
alter publication supabase_realtime add table public.cursor_events;
