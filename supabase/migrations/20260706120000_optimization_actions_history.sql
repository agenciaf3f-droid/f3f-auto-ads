-- Histórico de Otimizações: guarda o nome da campanha e do cliente NO MOMENTO da ação, pra que
-- a aba consiga listar campanhas já mantidas/desligadas mesmo depois que elas saem da avaliação
-- ao vivo (sararam ou foram pausadas por inteiro e não aparecem mais no /insights ACTIVE).
-- Sem isso, só teríamos o campaign_id nu — nada legível pra mostrar no histórico.
ALTER TABLE public.optimization_actions
  ADD COLUMN IF NOT EXISTS campaign_name TEXT,
  ADD COLUMN IF NOT EXISTS client_name TEXT;

-- Leitura do histórico é "as N ações mais recentes deste gestor" — índice por (user_id, created_at DESC).
-- O índice existente é (user_id, campaign_id, created_at DESC), que não serve pra essa ordenação global.
CREATE INDEX IF NOT EXISTS optimization_actions_user_created_idx
  ON public.optimization_actions (user_id, created_at DESC);
