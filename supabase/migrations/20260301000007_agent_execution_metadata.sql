-- Agent execution metadata from hook payloads (prompt, model, workspace_roots).
alter table public.agent_executions
  add column if not exists prompt text,
  add column if not exists model text,
  add column if not exists workspace_roots text[];

comment on column public.agent_executions.prompt is 'User initial message from beforeSubmitPrompt (agent description/title)';
comment on column public.agent_executions.model is 'AI model used for this execution';
comment on column public.agent_executions.workspace_roots is 'Workspace root paths from Cursor';
