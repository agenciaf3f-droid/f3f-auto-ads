-- Religar (restaurar) uma campanha desligada no Histórico: registra a ação `reactivated`, que
-- DESFAZ o tratamento anterior. Amplia o CHECK do action pra aceitar o novo valor.
ALTER TABLE public.optimization_actions DROP CONSTRAINT optimization_actions_action_check;
ALTER TABLE public.optimization_actions ADD CONSTRAINT optimization_actions_action_check
  CHECK (action IN ('dismissed', 'paused', 'reactivated'));
