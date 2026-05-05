# F3F AUTO-ADS — Guia para Claude

## O que é este projeto

Ferramenta SaaS para criação e publicação automatizada de anúncios no Meta Ads (Facebook/Instagram). Integra com a Meta Graph API via Supabase Edge Functions. Foco em dois tipos de campanha:

- **FASE 1** — Tráfego para perfil do Instagram (`OUTCOME_TRAFFIC`, `PROFILE_VISIT`, `INSTAGRAM_PROFILE`)
- **FASE 3** — Geração de leads via WhatsApp (`OUTCOME_LEADS`, `CONVERSATIONS`, `WHATSAPP`)

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| UI | shadcn/ui (Radix UI) + Tailwind CSS |
| Auth | Supabase Auth (email/senha) |
| Backend | Supabase Edge Functions (Deno/TypeScript) |
| API Meta | Meta Graph API v25.0 |

## Estrutura de diretórios

```
src/
  pages/          # Index, LoginPage, SettingsPage, MetaCallback, NotFound
  components/     # PublishForm (core), Header, LocationSelector, SearchableSelect, Fase3Components
  contexts/       # AuthContext (Supabase), ThemeContext (dark/light)
  lib/            # meta-api.ts (client), naming.ts, utils.ts
  integrations/   # Supabase client + types gerados

supabase/functions/
  meta-publish/         # Edge function principal — cria campaign > adset > creative > ad
  meta-publish-validate/
  meta-status/          # Verifica conexão Meta (token)
  meta-login/           # Redirect OAuth Meta
  meta-oauth-callback/  # Troca code por token
  meta-ad-accounts/     # Lista contas e IG accounts
  meta-audiences/       # Lista públicos (custom + saved)
  meta-campaigns/       # Lista campanhas existentes
  meta-whatsapp-numbers/
  meta-location-search/
  meta-validate-creative/
  meta-campaign-diagnostic/
  meta-fase1-diagnostic/
  meta-fase3-diagnostic/
  meta-adset-diff/
```

## Fluxo de publicação (`meta-publish`)

```
1. Validar identidade (page_id + instagram_actor_id)
2. Resolver mídia (IG shortcode → media_id  OU  Drive → upload)
3. Criar Campaign (PAUSED)
4. Criar Adset (ACTIVE) — com promoted_object correto por preset
5. Criar Adcreative
6. Criar Ad (ACTIVE)
```

## Regras críticas por preset

### FASE 1
- `optimization_goal: PROFILE_VISIT` + `destination_type: INSTAGRAM_PROFILE`
- `promoted_object` do adset **DEVE** ter `{ page_id, instagram_profile_id }` — sem `instagram_profile_id` o ad falha com error 100/2446391
- `targeting_automation: { advantage_audience: 0 }` (desativado)
- Creative: `source_instagram_media_id` + `instagram_user_id` + `call_to_action: VISIT_PROFILE`

### FASE 3
- `optimization_goal: CONVERSATIONS` + `destination_type: WHATSAPP`
- `promoted_object` do adset: `{ page_id, whats_app_business_phone_number_id, whatsapp_phone_number }` — exatamente 3 campos
- `attribution_spec: [{ event_type: CLICK_THROUGH, window_days: 1 }]`
- `targeting_automation: { advantage_audience: 1 }` (ativado)
- Creative: `source_instagram_media_id` + `instagram_user_id` + `call_to_action: WHATSAPP_MESSAGE`
- Ad: inclui `tracking_specs` para onsite_conversion, messenger e whatsapp

## Erros Meta conhecidos

| Code | Subcode | Causa | Fix |
|------|---------|-------|-----|
| 100 | 2446391 | Ad rejeitado — creative incompatível com adset | Garantir `instagram_profile_id` no `promoted_object` do adset FASE 1 |
| 2 | — | Erro transiente Meta | Retry automático (3x com backoff 2s/6s/15s) |

## Variáveis de ambiente

```
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_SUPABASE_PROJECT_ID
# Edge functions (Supabase secrets):
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY            # Convite de gestores via email
RESEND_FROM_EMAIL         # ex: "F3F AUTO-ADS <noreply@agenciaf3f.com.br>"
APP_URL                   # ex: https://f3f-auto-ads.vercel.app (link no email)
```

## Comandos

```bash
npm run dev        # Dev server porta 8080
npm run build      # Build produção
npm run test       # Vitest
```

## Deploy das edge functions

As functions ficam em `supabase/functions/`. Deploy via Supabase CLI:
```bash
supabase functions deploy meta-publish
```

## Banco de dados (Supabase)

Tabelas relevantes:
- `meta_connections` — token OAuth do gestor. **UNIQUE(user_id)** garante 1 conexão Meta por gestor. RLS por `auth.uid()`.
- `publish_jobs` — deduplicação/idempotência de publicações (fingerprint SHA-256)
- `app_admins` — usuários com permissão de convidar novos gestores. RLS apenas SELECT do próprio user.

## Multi-tenancy (gestores isolados)

Cada gestor tem sua própria conta no Supabase Auth. Sessões, conexões Meta e publicações são isoladas por `auth.uid()` via RLS + filtros explícitos nas edge functions. **Signup público está desabilitado** — onboarding é via convite por admin.

### Onboarding de gestor (admin)

1. Login como admin (qualquer user em `public.app_admins`).
2. Header → botão "Admin" → preencher Nome + Email → "Enviar convite".
3. A edge function `admin-invite-user` cria o user no Supabase Auth com senha provisória e dispara email via Resend (`noreply@agenciaf3f.com.br`).
4. Gestor recebe email, faz login, opcionalmente troca senha em "Esqueci minha senha".

### Como adicionar um novo admin

Rodar manualmente no SQL Editor do Supabase:
```sql
INSERT INTO public.app_admins (user_id)
SELECT id FROM auth.users WHERE email = 'novo@admin.com';
```

### Configuração inicial pós-deploy

```bash
# Aplicar migrations
supabase db push

# Configurar secrets das edge functions
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx
supabase secrets set RESEND_FROM_EMAIL="F3F AUTO-ADS <noreply@agenciaf3f.com.br>"
supabase secrets set APP_URL="https://f3f-auto-ads.vercel.app"

# Deploy edge functions
supabase functions deploy admin-invite-user

# Painel Supabase → Authentication → Settings:
#   - Desabilitar "Enable new user signups"
#   - Site URL: https://f3f-auto-ads.vercel.app

# Designar admin inicial via SQL Editor
INSERT INTO public.app_admins (user_id)
SELECT id FROM auth.users WHERE email = 'agenciaf3f@gmail.com';
```

## Contexto comercial

Produto voltado para venda em massa. Usuários são gestores de tráfego que precisam subir campanhas FASE 1 e FASE 3 rapidamente sem acessar o Gerenciador de Anúncios do Meta.
