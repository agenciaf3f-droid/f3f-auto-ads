// Edge function: admin remove um gestor (apaga do Supabase Auth).
// Acesso restrito: caller precisa estar em public.app_admins.
// GUARDA CRÍTICA: o admin não pode remover a própria conta.
// A linha em app_admins e demais tabelas com FK ON DELETE CASCADE
// (profiles, meta_connections, publish_jobs, clients...) somem junto.
// Sem entrada em config.toml => verify_jwt=true (default) protege.

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
      console.log("[admin-remove-user] Auth error:", authError?.message);
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
      console.log("[admin-remove-user] Caller não é admin:", user.id);
      return json({ error: "Apenas administradores podem remover gestores" }, 403);
    }

    // 3. Validar body.
    const body = await req.json().catch(() => ({}));
    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    if (!userId) {
      return json({ error: "user_id obrigatório" }, 400);
    }

    // 4. GUARDA: o admin não pode remover a própria conta.
    if (userId === user.id) {
      return json({ error: "Você não pode remover a própria conta" }, 400);
    }

    // 5. Apagar do Auth. app_admins + tabelas com FK ON DELETE CASCADE somem junto.
    const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
    if (delErr) {
      console.error("[admin-remove-user] deleteUser error:", delErr.message);
      return json({ error: delErr.message }, 500);
    }

    console.log("[admin-remove-user] Gestor removido:", userId, "por:", user.id);
    return json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin-remove-user] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
