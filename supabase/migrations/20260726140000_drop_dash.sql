-- Rollback da feature "Dash" (teste concluído, aprovado, removido do app em 2026-07-26 a pedido
-- do usuário — código guardado localmente pra reaproveitar depois, possivelmente como app próprio).
-- Tabela já dropada diretamente em prod nesta mesma sessão; migration adicionada aqui só pra manter
-- o histórico local/remoto consistente (evita o mesmo drift de migration já visto neste projeto).
DROP TABLE IF EXISTS public.dash CASCADE;
