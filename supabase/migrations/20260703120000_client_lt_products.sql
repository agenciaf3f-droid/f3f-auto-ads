-- Produtos Low-Ticket (L.T) por cliente. L.T é identificada pela nomenclatura [PRODUTO] no nome da
-- campanha (varia por produto/cliente, ex: [DDX]); FASE 1/2/3 usam bucket fixo [FASE N] e não
-- precisam disso. 1 cliente pode ter vários produtos L.T. Multi-tenant por user_id (RLS auth.uid()),
-- mesmo padrão de client_ad_accounts.
CREATE TABLE public.client_lt_products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- CHECK anti-vazio: produto em branco viraria campaign_name_filter='' na regra, que o
  -- optimization-engine trata como bucket-only (casaria TODA campanha L.T). Sempre trim no FE.
  product_name TEXT NOT NULL CHECK (length(btrim(product_name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.client_lt_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own client_lt_products" ON public.client_lt_products FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own client_lt_products" ON public.client_lt_products FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own client_lt_products" ON public.client_lt_products FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own client_lt_products" ON public.client_lt_products FOR DELETE USING (auth.uid() = user_id);
-- Unicidade case-insensitive por cliente (Mari não repete DDX). Índice também serve lookups por
-- client_id (prefixo mais à esquerda) → sem índice client_id separado.
CREATE UNIQUE INDEX client_lt_products_client_name_idx ON public.client_lt_products (client_id, lower(product_name));
