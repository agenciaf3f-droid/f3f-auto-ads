// Edge function: lista os dashboards de cliente (nome + email + grupo de WhatsApp) da base
// Agenciaf3f (client_dashboards), pra auto-casar por nome e pré-preencher o grupo no ClientForm.
// Acesso: qualquer gestor autenticado (não é dado sensível de conta própria, só o mapa cliente→grupo).

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

interface DashboardRow {
  nome: string;
  email: string | null;
  whatsapp_group_id: string;
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

    // 1. Validar caller via JWT (base própria, não a Agenciaf3f).
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      console.log("[list-client-dashboards] Auth error:", authError?.message);
      return json({ error: "Sessão inválida" }, 401);
    }

    // 2. Ler client_dashboards da base Agenciaf3f via service_role (REST direto — cross-project).
    const agenciaf3fUrl = Deno.env.get("AGENCIAF3F_URL");
    const agenciaf3fServiceRoleKey = Deno.env.get("AGENCIAF3F_SERVICE_ROLE_KEY");
    if (!agenciaf3fUrl || !agenciaf3fServiceRoleKey) {
      console.error("[list-client-dashboards] AGENCIAF3F_URL / AGENCIAF3F_SERVICE_ROLE_KEY não configurados");
      return json({ error: "Integração com a base Agenciaf3f não configurada" }, 500);
    }

    const endpoint =
      `${agenciaf3fUrl}/rest/v1/client_dashboards?select=nome,email,whatsapp_group_id&whatsapp_group_id=not.is.null`;
    const resp = await fetch(endpoint, {
      headers: {
        apikey: agenciaf3fServiceRoleKey,
        Authorization: `Bearer ${agenciaf3fServiceRoleKey}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("[list-client-dashboards] Agenciaf3f REST error:", resp.status, text);
      return json({ error: "Falha ao consultar a base Agenciaf3f" }, 502);
    }

    const dashboards = (await resp.json()) as DashboardRow[];
    return json({ dashboards });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[list-client-dashboards] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
