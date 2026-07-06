-- Tabela local (cache) dos grupos de WhatsApp conhecidos, sincronizada sob demanda da base
-- Agenciaf3f (client_dashboards + log de mensagens) pela edge sync-whatsapp-groups.
-- Existe pra list-client-dashboards não precisar reler ~99k linhas do log a cada abertura do
-- ClientForm — a leitura pesada roda só quando alguém aperta "sincronizar".
CREATE TABLE IF NOT EXISTS public.whatsapp_groups (
  group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'client_dashboards',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_groups ENABLE ROW LEVEL SECURITY;

-- Leitura liberada pra qualquer gestor autenticado (mesma política de list-client-dashboards
-- hoje: não é dado sensível de conta própria, só o mapa grupo->nome). Escrita só via
-- service_role (edge sync-whatsapp-groups), por isso não há policy de insert/update/delete.
CREATE POLICY "authenticated_can_read_whatsapp_groups"
  ON public.whatsapp_groups
  FOR SELECT
  TO authenticated
  USING (true);
