-- Performance indexes
CREATE INDEX IF NOT EXISTS publish_jobs_user_created_idx
  ON public.publish_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS publish_jobs_user_status_idx
  ON public.publish_jobs (user_id, status)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS meta_connections_expires_idx
  ON public.meta_connections (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS message_templates_user_created_idx
  ON public.message_templates (user_id, created_at DESC);
