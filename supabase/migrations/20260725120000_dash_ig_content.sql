-- Aba Dash: conteúdo orgânico do Instagram por cliente (posts/reels + engajamento), puxado sob
-- demanda via Graph API (botão "Sincronizar"). Multi-tenant por user_id (RLS auth.uid()), mesmo
-- padrão de clients/client_lt_products. update_updated_at_column() já existe
-- (20260305163433_...sql) — não redefinir.

CREATE TABLE public.dash (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  ig_media_id TEXT NOT NULL,          -- id do post/reel na Graph — chave de dedup no upsert
  media_type TEXT,                    -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type TEXT,            -- FEED | REELS | STORY — fonte real de "Tipo" (Reel)
  posted_at TIMESTAMPTZ,              -- "timestamp" da Graph
  like_count INTEGER,
  comments_count INTEGER,
  views_count INTEGER,                -- nullable — reels; null se a Graph não devolver/rate-limit
  caption TEXT,
  permalink TEXT,
  student_name TEXT,                  -- "Nome do aluno" — editável na tela, sync nunca sobrescreve
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, ig_media_id)
);

ALTER TABLE public.dash ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own dash" ON public.dash FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own dash" ON public.dash FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own dash" ON public.dash FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own dash" ON public.dash FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_dash_updated_at BEFORE UPDATE ON public.dash
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX dash_client_idx ON public.dash (client_id, posted_at DESC);
