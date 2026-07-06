// Edge function: lista os grupos de WhatsApp conhecidos (tabela local whatsapp_groups, mantida
// por sync-whatsapp-groups), pra auto-casar por nome e pré-preencher o grupo no ClientForm.
// Leitura local e rápida — a sincronização pesada (Agenciaf3f: client_dashboards + log de
// mensagens, ~99k linhas) roda à parte, sob demanda, na edge sync-whatsapp-groups.
// Acesso: qualquer gestor autenticado (não é dado sensível de conta própria, só o mapa grupo->nome).

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

    // Cliente com o JWT do caller — respeita a policy de SELECT (authenticated) de
    // whatsapp_groups, não precisa de service_role pra essa leitura.
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      console.log("[list-client-dashboards] Auth error:", authError?.message);
      return json({ error: "Sessão inválida" }, 401);
    }

    const { data, error } = await authClient
      .from("whatsapp_groups")
      .select("group_id, name")
      .order("name", { ascending: true });

    if (error) {
      console.error("[list-client-dashboards] Query falhou:", error.message);
      return json({ error: "Falha ao listar grupos" }, 500);
    }

    const dashboards = (data ?? []).map((row) => ({
      nome: row.name,
      email: null as string | null,
      whatsapp_group_id: row.group_id,
    }));

    return json({ dashboards });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[list-client-dashboards] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
