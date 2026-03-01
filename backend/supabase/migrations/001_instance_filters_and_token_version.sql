-- Add notification_filters: array of allowed event types per instance (NULL = all types allowed)
ALTER TABLE cursor_instances ADD COLUMN IF NOT EXISTS notification_filters text[] DEFAULT NULL;

-- Add token_version for hook token rotation (increment to invalidate old tokens)
ALTER TABLE cursor_instances ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 1;
