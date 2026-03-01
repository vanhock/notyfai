-- Add pending status to agent_executions.
-- Threads are created with status=pending by sessionStart and become
-- visible (running) only after beforeSubmitPrompt fires.
alter table public.agent_executions
  alter column status set default 'pending';

comment on column public.agent_executions.status is
  'pending | running | blocked | stopped — forward-only lifecycle';
