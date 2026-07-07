// Edge function: admin lista os gestores (membros) do app.
// Acesso restrito: caller precisa estar em public.app_admins.
// Mesma validação de admin-invite-user: valida o JWT do caller + checa app_admins
// via service_role. Sem entrada em config.toml => verify_jwt=true (default) protege.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
      console.log("[admin-list-users] Auth error:", authError?.message);
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
      console.log("[admin-list-users] Caller não é admin:", user.id);
      return json({ error: "Apenas administradores podem listar gestores" }, 403);
    }

    // 3. Listar usuários do Auth (service_role). Página única de 1000 —
    //    suficiente p/ o volume deste app; se um dia passar disso, paginar.
    const { data: listData, error: listErr } = await adminClient.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listErr) {
      console.error("[admin-list-users] listUsers error:", listErr.message);
      return json({ error: listErr.message }, 500);
    }

    // 4. Conjunto de admins p/ marcar is_admin em cada linha.
    const { data: admins } = await adminClient.from("app_admins").select("user_id");
    const adminIds = new Set((admins ?? []).map((a) => a.user_id));

    const users = (listData?.users ?? [])
      .map((u) => ({
        id: u.id,
        email: u.email ?? null,
        name: (u.user_metadata as { name?: string } | null)?.name ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        is_admin: adminIds.has(u.id),
      }))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

    return json({ ok: true, users });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin-list-users] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
