-- Grupo de WhatsApp do cliente (importado da base Agenciaf3f na criação do cliente).
-- Nullable: nem todo cliente tem grupo mapeado em client_dashboards.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS whatsapp_group_id TEXT;
