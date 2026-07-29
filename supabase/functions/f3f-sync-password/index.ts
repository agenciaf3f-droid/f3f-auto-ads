// Edge function: propaga a senha recém-definida no Console.Ads para o login
// central F3F (Supabase Agenciaf3f). Chamada pelo frontend logo após o
// supabase.auth.updateUser({ password }) local (ResetPasswordPage /
// FirstLoginPassword) — sem isso a senha do espelho diverge da central.
// O caller só troca a PRÓPRIA senha (email vem do JWT validado, nunca do body).
// Sem entrada em config.toml => verify_jwt=true (default) protege.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

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

async function findUserByEmail(admin: SupabaseClient, email: string) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers central: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Não autenticado" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // 1. Validar o próprio usuário via JWT local (csfpq).
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user?.email) return json({ error: "Sessão inválida" }, 401);

    const body = await req.json().catch(() => ({}));
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 6) return json({ error: "Senha inválida" }, 400);

    // 2. Atualizar a MESMA pessoa no central (por email do JWT, não do body).
    const centralUrl = Deno.env.get("F3F_CENTRAL_URL");
    const centralKey = Deno.env.get("F3F_CENTRAL_SERVICE_ROLE_KEY");
    if (!centralUrl || !centralKey) {
      // Central não configurado ainda → no-op declarado (não bloqueia o fluxo local).
      console.log("[f3f-sync-password] central não configurado — pulando sync");
      return json({ ok: true, synced: false });
    }
    const central = createClient(centralUrl, centralKey);
    const centralUser = await findUserByEmail(central, user.email.toLowerCase());
    if (!centralUser) {
      console.log("[f3f-sync-password] usuário sem conta central:", user.email);
      return json({ ok: true, synced: false });
    }

    const { error: updErr } = await central.auth.admin.updateUserById(centralUser.id, {
      password,
      user_metadata: { ...centralUser.user_metadata, must_change_password: false },
    });
    if (updErr) {
      console.error("[f3f-sync-password] update central falhou:", updErr.message);
      return json({ ok: true, synced: false, warning: updErr.message });
    }

    console.log("[f3f-sync-password] senha sincronizada:", user.email);
    return json({ ok: true, synced: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[f3f-sync-password] Unexpected:", msg);
    return json({ error: msg }, 500);
  }
});
