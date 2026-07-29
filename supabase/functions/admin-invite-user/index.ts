// Edge function: admin convida um novo gestor.
// Desde o login central F3F (2026-07): NÃO cria mais a conta direto aqui.
// Delega pra edge f3f-auth-provision do Supabase central (Agenciaf3f), que:
//   1. cria a pessoa em auth.users do central (senha única F3F),
//   2. registra em f3f_logins (system='console-ads'),
//   3. cria a conta ESPELHO neste projeto (mesma senha; RLS/FKs locais intactas),
//   4. envia o email de credenciais via Resend.
// Acesso restrito: caller precisa estar em public.app_admins (gate local).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return json({ error: "Não autenticado" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. Validar caller via JWT.
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      console.log("[admin-invite-user] Auth error:", authError?.message);
      return json({ error: "Sessão inválida" }, 401);
    }

    // 2. Verificar se caller é admin (via service role para bypassar RLS).
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: adminRow } = await adminClient
      .from("app_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!adminRow) {
      console.log("[admin-invite-user] Caller não é admin:", user.id);
      return json({ error: "Apenas administradores podem convidar gestores" }, 403);
    }

    // 3. Validar body.
    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!email || !email.includes("@")) {
      return json({ error: "Email inválido" }, 400);
    }
    if (!name || name.length < 2) {
      return json({ error: "Nome obrigatório" }, 400);
    }

    // 4. Delegar pro central (service-to-service: Bearer = service_role do central).
    const centralUrl = Deno.env.get("F3F_CENTRAL_URL");
    const centralKey = Deno.env.get("F3F_CENTRAL_SERVICE_ROLE_KEY");
    if (!centralUrl || !centralKey) {
      return json({ error: "Login central não configurado (F3F_CENTRAL_URL/KEY)" }, 500);
    }

    // Pré-checagem local: espelho já existe? (mantém o 409 claro de antes)
    const { data: existing } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (existing?.users.some((u) => (u.email ?? "").toLowerCase() === email)) {
      return json({ error: "Já existe um usuário com este email" }, 409);
    }

    const res = await fetch(`${centralUrl}/functions/v1/f3f-auth-provision`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${centralKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        name,
        systems: ["console-ads"],
        invited_by: `console-ads:${user.id}`,
      }),
    });
    const result = await res.json().catch(() => ({}));
    // result.ok !== true cobre também body inválido/vazio (json() falhou) —
    // sem isso, HTTP 200 com body quebrado viraria sucesso com user_id undefined.
    if (!res.ok || result.error || result.ok !== true) {
      console.error("[admin-invite-user] provision central falhou:", result.error ?? res.status);
      return json({ error: result.error ?? `Central retornou HTTP ${res.status}` }, 502);
    }
    if (result.warning) {
      // Conta criada mas email falhou — repassa como erro acionável (reenviar o
      // convite reaproveita a conta central e reenvia credenciais).
      console.error("[admin-invite-user] warning do central:", result.warning);
      return json({ error: result.warning }, 502);
    }

    console.log("[admin-invite-user] Convite via central:", email, "espelho:", result.mirror_console_ads_user_id);
    return json({ ok: true, user_id: result.mirror_console_ads_user_id ?? result.auth_user_id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin-invite-user] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
