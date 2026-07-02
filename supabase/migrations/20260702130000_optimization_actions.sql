-- Otimizações: guarda decisão do gestor sobre um alerta de KPI (dispensar ou pausar),
-- pra não reexibir o mesmo card em toda visita à aba.
CREATE TABLE public.optimization_actions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('dismissed', 'paused')),
  metric_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.optimization_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own optimization actions" ON public.optimization_actions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own optimization actions" ON public.optimization_actions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX optimization_actions_user_campaign_idx
  ON public.optimization_actions (user_id, campaign_id, created_at DESC);
