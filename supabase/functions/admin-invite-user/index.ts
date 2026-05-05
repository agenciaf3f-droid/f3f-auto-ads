// Edge function: admin convida um novo gestor.
// Cria o user no Supabase Auth (com senha provisória) e envia email com credenciais.
// Acesso restrito: caller precisa estar em public.app_admins.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendInviteEmail } from "../_shared/email.ts";

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

function generateTempPassword(): string {
  // 12 chars hex — suficientemente aleatório, fácil de copiar do email.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

    // 4. Criar user.
    const tempPassword = generateTempPassword();
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { name, invited_by: user.id },
    });

    if (createErr) {
      console.log("[admin-invite-user] createUser error:", createErr.message);
      const lower = createErr.message.toLowerCase();
      if (lower.includes("already") || lower.includes("registered")) {
        return json({ error: "Já existe um usuário com este email" }, 409);
      }
      return json({ error: createErr.message }, 500);
    }

    if (!created.user) {
      return json({ error: "Falha ao criar usuário" }, 500);
    }

    // 5. Enviar email de convite. Se falhar, rollback do user.
    const sent = await sendInviteEmail({ toEmail: email, toName: name, tempPassword });
    if (!sent.ok) {
      console.error("[admin-invite-user] Email falhou, fazendo rollback do user:", created.user.id);
      await adminClient.auth.admin.deleteUser(created.user.id);
      return json({ error: `Email falhou: ${sent.reason}` }, 502);
    }

    console.log("[admin-invite-user] Convite enviado:", email, "user_id:", created.user.id);
    return json({ ok: true, user_id: created.user.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin-invite-user] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
