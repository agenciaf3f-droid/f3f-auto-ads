// Edge function: pergunta ao login central F3F se o usuário logado continua
// com acesso ativo ao Console.Ads (f3f_logins: system='console-ads').
// Usada pelo AuthContext no boot da sessão — desativar no central corta o
// acesso aqui mesmo com a conta espelho ainda existindo.
// Fail-open: central fora do ar ou sem linha → não derruba ninguém.
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
    if (!authHeader) return json({ error: "Não autenticado" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user?.email) return json({ error: "Sessão inválida" }, 401);

    const centralUrl = Deno.env.get("F3F_CENTRAL_URL");
    const centralKey = Deno.env.get("F3F_CENTRAL_SERVICE_ROLE_KEY");
    if (!centralUrl || !centralKey) return json({ active: true, tracked: false });

    const central = createClient(centralUrl, centralKey);
    const { data: row, error } = await central
      .from("f3f_logins")
      .select("active")
      .eq("email", user.email.toLowerCase())
      .eq("system", "console-ads")
      .maybeSingle();

    if (error) {
      console.error("[f3f-login-status] query central falhou:", error.message);
      return json({ active: true, tracked: false }); // fail-open
    }
    if (!row) return json({ active: true, tracked: false }); // sem linha = legado, não derruba

    return json({ active: row.active === true, tracked: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[f3f-login-status] Unexpected:", msg);
    return json({ active: true, tracked: false }); // fail-open
  }
});
