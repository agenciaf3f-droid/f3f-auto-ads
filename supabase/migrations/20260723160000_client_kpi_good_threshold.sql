-- Meta "boa" do KPI: mesma linha da regra ruim (ruim/bom são as 2 pontas do mesmo metric_key),
-- opcional — NULL nos dois = regra sem meta boa configurada (comportamento anterior, só avalia "ruim").
ALTER TABLE public.client_kpi_rules ADD COLUMN good_comparator TEXT CHECK (good_comparator IN ('>', '<'));
ALTER TABLE public.client_kpi_rules ADD COLUMN good_threshold_value NUMERIC;
