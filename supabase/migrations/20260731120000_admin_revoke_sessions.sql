-- Revogação de sessões de OUTRO usuário, para o admin redefinir senha pela UI
-- (edge admin-update-user). O schema `auth` não é acessível via PostgREST e o
-- supabase-js só expõe `auth.admin.signOut(jwt)` — que exige o JWT do próprio
-- usuário, coisa que o admin não tem. Daí a função SECURITY DEFINER.
--
-- Segurança: EXECUTE revogado de public/anon/authenticated e concedido só ao
-- service_role — ou seja, só alcançável de dentro de uma edge function que já
-- validou `app_admins`. Não expõe leitura de sessão, só apaga por user_id.
create or replace function public.admin_revoke_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  -- refresh_tokens.user_id é varchar no schema do GoTrue (sessions.user_id é uuid).
  delete from auth.refresh_tokens where user_id = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.admin_revoke_sessions(uuid) from public;
revoke all on function public.admin_revoke_sessions(uuid) from anon;
revoke all on function public.admin_revoke_sessions(uuid) from authenticated;
grant execute on function public.admin_revoke_sessions(uuid) to service_role;
