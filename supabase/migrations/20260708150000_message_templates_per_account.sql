-- Templates de mensagem salvos ("Salvar template") passam a ser POR CONTA DE ANÚNCIO.
-- Antes eram só por usuário (auth.uid()) sem filtro de conta → o template aparecia em TODAS
-- as contas. Agora o frontend filtra por ad_account_id. Coluna nullable: rows antigas (NULL)
-- simplesmente não aparecem em nenhuma conta (usuário re-salva). RLS por auth.uid() inalterada.
ALTER TABLE public.message_templates ADD COLUMN IF NOT EXISTS ad_account_id text;
