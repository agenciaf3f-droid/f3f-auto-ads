-- L.T (baixo ticket) não tem string fixa de campanha (varia por PRODUTO — ver generateLtCampaignName
-- em src/lib/naming.ts). FASE 1/2/3 seguem fixas ([FASE N]) e não precisam desse filtro.
-- Coluna NOT NULL DEFAULT '': FASE 1/2/3 ficam com '' (sem produto); regras L.T guardam o nome do
-- produto. Usar '' em vez de NULL mantém a unicidade abaixo simples (índice de 4 colunas comum, sem
-- semântica de NULLs distintos). Linhas existentes são preenchidas com '' pelo DEFAULT.
ALTER TABLE public.client_kpi_rules ADD COLUMN campaign_name_filter TEXT NOT NULL DEFAULT '';

-- A unicidade da regra passa a incluir o produto: dois produtos L.T na mesma conta podem ter regra
-- na MESMA métrica (ex: [DDX] e [OUTRO], ambos com cpc). FASE 1/2/3 continuam 1 regra/métrica porque
-- compartilham campaign_name_filter=''. Troca o UNIQUE de 3 colunas (nome auto-gerado/truncado, então
-- localizado pela definição) pelo de 4 colunas.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'public.client_kpi_rules'::regclass AND contype = 'u'
     AND pg_get_constraintdef(oid) = 'UNIQUE (client_ad_account_id, preset_bucket, metric_key)';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.client_kpi_rules DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.client_kpi_rules
  ADD CONSTRAINT client_kpi_rules_account_bucket_metric_product_key
  UNIQUE (client_ad_account_id, preset_bucket, metric_key, campaign_name_filter);
