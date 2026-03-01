-- Blocking timer: from "before*" hook until "after*" or "stop".
-- blocked_since set when a before* is processed; cleared when after* or stop is processed.
alter table public.agent_executions
  add column if not exists blocked_since timestamptz,
  add column if not exists blocking_event_type text,
  add column if not exists blocking_tool_name text;

comment on column public.agent_executions.blocked_since is 'Set when a before* hook fires; cleared when matching after* or stop fires';
comment on column public.agent_executions.blocking_event_type is 'Cursor hook event type that started the block (e.g. beforeShellExecution)';
comment on column public.agent_executions.blocking_tool_name is 'Display string: tool_name, command, or file_path from the blocking hook payload';
