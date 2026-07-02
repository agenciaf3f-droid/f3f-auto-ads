-- L.T (baixo ticket) não tem string fixa de campanha (varia por PRODUTO — ver generateLtCampaignName
-- em src/lib/naming.ts). FASE 1/2/3 seguem fixas ([FASE N]) e não precisam desse filtro.
-- Coluna nullable: regras existentes (inclusive as de FASE 1/2/3) continuam válidas sem preenchê-la;
-- para regras L.T, o filtro é exigido no FE mas não impomos NOT NULL aqui (evita quebrar linhas antigas).
ALTER TABLE public.client_kpi_rules ADD COLUMN campaign_name_filter TEXT;
