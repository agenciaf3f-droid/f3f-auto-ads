-- Multi-tenancy hardening: isolar conexões Meta por gestor + tabela de admins.

-- 1. Limpar tokens compartilhados.
--    A migration 20260326180415 sobrescreveu access_token de todas as linhas
--    com um único token hardcoded (vazado no Git). Forçar reconexão de todos.
DELETE FROM public.meta_connections;

-- 2. Garantir 1 conexão Meta por gestor (defesa contra race conditions e migrations futuras).
ALTER TABLE public.meta_connections
  ADD CONSTRAINT meta_connections_user_id_key UNIQUE (user_id);

-- 3. Tabela de admins. Quem pode convidar novos gestores.
CREATE TABLE IF NOT EXISTS public.app_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;

-- O próprio admin pode ler sua linha (UI usa pra mostrar/esconder botão Admin).
CREATE POLICY "Admins can read own row" ON public.app_admins
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE só via service_role (edge functions).
-- Sem policies => bloqueado para usuários normais.

-- ATENÇÃO: rodar manualmente no SQL Editor após aplicar a migration:
--   INSERT INTO public.app_admins (user_id)
--   SELECT id FROM auth.users WHERE email = 'agenciaf3f@gmail.com';
