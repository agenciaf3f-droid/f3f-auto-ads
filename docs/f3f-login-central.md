# Login central F3F — como o Console.Ads se integra

> Briefing auto-contido. Vale para qualquer agente/dev que mexer em auth neste repo.

## O que é

A F3F unificou a **credencial** (email + senha) dos sistemas internos num único banco: o Supabase principal **Agenciaf3f — ref `ulikfkemdawinetjyhok`**. Lá vivem `auth.users` (senha, bcrypt do Supabase Auth), `public.f3f_logins` (quem acessa qual sistema; `system='console-ads'` aqui) e as edges `f3f-auth-check` / `f3f-auth-provision` / `f3f-auth-deactivate` / `f3f-auth-set-password`.

**O que NÃO mudou — regra, não sugestão:** autorização é local. `app_admins`, RLS (`auth.uid()`), FKs para `auth.users` deste projeto, edge functions de dados: intocados. Só autenticação/provisionamento mudou de dono.

## Modelo deste repo — "Modo B" (espelho)

O login continua acontecendo **neste** projeto (`csfpqioxmsocdqavwkvn`): 32 policies RLS e 9 FKs dependem do `auth.users` local. O central manda na senha e no acesso:

| Fluxo | Antes | Agora |
|---|---|---|
| Convite (`admin-invite-user`) | criava conta local + email | delega pra `f3f-auth-provision` do central (Bearer = `F3F_CENTRAL_SERVICE_ROLE_KEY`), que cria no central **e** cria a conta espelho aqui com a mesma senha provisória, e envia o email (Resend do central) |
| Troca de senha (reset / 1º login) | só local | local **+** `f3f-sync-password` (edge nova) propaga pro central |
| Remoção (`admin-remove-user`) | só local | local **+** `f3f-auth-deactivate` (`systems:['console-ads']`) no central |
| Boot de sessão (`AuthContext`) | — | `f3f-login-status` (edge nova) consulta `f3f_logins`; `active=false` → signOut. Fail-open |

Sentido inverso: quando a senha muda em outro sistema F3F, a edge `f3f-auth-set-password` **do central** atualiza a conta espelho daqui (o central tem `CONSOLE_ADS_SERVICE_ROLE_KEY`).

## Secrets (via `supabase secrets set --project-ref csfpqioxmsocdqavwkvn`)

```
F3F_CENTRAL_URL=https://ulikfkemdawinetjyhok.supabase.co
F3F_CENTRAL_SERVICE_ROLE_KEY=...   # service_role do central; NUNCA no frontend
```

## Proibido

1. Recriar criação/reset de senha local sem propagar ao central (diverge o espelho).
2. Mexer em RLS/FKs/`auth.uid()` por causa de auth — não é necessário.
3. Remapear UUID de usuário: `meta_connections`/`meta-status` chaveiam o token Meta compartilhado pelo `auth.users.id` de um admin — quebra publicação da agência **sem erro visível**.
4. `service_role` (local ou do central) em bundle de frontend.
5. Senha em texto em tabela.

## Checklist de aceite

- [ ] Convite cria conta no central + espelho aqui + email chega; RLS continua ok pro convidado.
- [ ] Reset/1º login troca a senha aqui **e** no central (`f3f-sync-password` retorna `synced:true` nos logs).
- [ ] `active=false` no central → próximo boot desloga.
- [ ] `meta-status` continua devolvendo token Meta válido (falha silenciosa conhecida).
- [ ] `npx tsc -p tsconfig.app.json` limpo (`tsc --noEmit` é no-op neste repo).
