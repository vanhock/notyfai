-- Realtime: enable for agent_executions so the app can subscribe to execution changes
alter publication supabase_realtime add table public.agent_executions;
