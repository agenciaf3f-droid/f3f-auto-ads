// Edge function: envia uma mensagem de TESTE via UAZAPI pra um grupo informado — valida token +
// instância + envio de ponta a ponta SEM precisar pausar uma campanha real. Se falhar, devolve o
// motivo real (o _shared/uazapi.ts já expõe o corpo do erro da UAZAPI).
// Restrito a ADMIN (public.app_admins): dispara WhatsApp real, não pode ser gatilho de gestor comum.
// Modelo privilegiado: espelha admin-invite-user (JWT + checagem de admin via service role).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendWhatsAppText } from "../_shared/uazapi.ts";

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

// Mesma canonicalização de sync-whatsapp-groups: "120363...-group" | "120363...@g.us" -> "120363...@g.us"
// (forma aceita pela UAZAPI). Duplicado aqui (3 linhas) de propósito — não acopla as duas edges nem
// obriga a mexer em sync-whatsapp-groups. Vazio/lixo -> null.
function canonicalGroupId(raw: string | null | undefined): string | null {
  const id = (raw ?? "").trim().replace(/-group$/, "").replace(/@g\.us$/, "");
  return id ? `${id}@g.us` : null;
}

const DEFAULT_MESSAGE =
  "✅ Teste de integração — F3F AUTO-ADS. Se você recebeu isto, o envio via WhatsApp está funcionando.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Não autenticado" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. Validar caller via JWT.
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      console.log("[whatsapp-test-send] Auth error:", authError?.message);
      return json({ error: "Sessão inválida" }, 401);
    }

    // 2. Só admin: ferramenta de teste que dispara WhatsApp real. Checa via service role (bypassa RLS).
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: adminRow } = await adminClient
      .from("app_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!adminRow) {
      console.log("[whatsapp-test-send] Caller não é admin:", user.id);
      return json({ error: "Apenas administradores podem enviar teste de WhatsApp" }, 403);
    }

    // 3. Validar body.
    const body = await req.json().catch(() => ({}));
    const groupId = canonicalGroupId(typeof body.group_id === "string" ? body.group_id : "");
    if (!groupId) return json({ error: "group_id inválido" }, 400);
    const message =
      typeof body.message === "string" && body.message.trim() ? body.message.trim() : DEFAULT_MESSAGE;

    // 4. Envio real via UAZAPI. Falha (secret ausente, token inválido, grupo inexistente) volta como
    // { ok:false, reason } com status 200 — assim o motivo REAL chega no `data` do supabase-js
    // (numa resposta non-2xx ele não parsearia o body e a causa se perderia).
    const sent = await sendWhatsAppText({ groupId, text: message });
    if (!sent.ok) {
      console.log("[whatsapp-test-send] Envio UAZAPI falhou:", sent.reason);
      return json({ ok: false, reason: sent.reason });
    }
    return json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[whatsapp-test-send] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
