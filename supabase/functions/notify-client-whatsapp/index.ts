// Edge function: avisa o grupo de WhatsApp do cliente quando um gestor pausa um
// conjunto (adset), criativo (ad) ou a campanha inteira (campaign) na aba Otimizações.
// Modelo privilegiado (espelha admin-invite-user): valida o JWT do caller via
// anon client, depois usa service-role p/ resolver o grupo do cliente.
// Envio real via UAZAPI (_shared/uazapi.ts). Link do criativo via Graph API v25.0.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendWhatsAppText } from "../_shared/uazapi.ts";

const GRAPH = "https://graph.facebook.com/v25.0";

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

// Cadeia de fallback do link público de um ad:
// creative.instagram_permalink_url → FB via effective_object_story_id → preview_shareable_link → null.
function pickLink(ad: {
  preview_shareable_link?: string | null;
  creative?: {
    instagram_permalink_url?: string | null;
    effective_object_story_id?: string | null;
  } | null;
}): string | null {
  const c = ad?.creative;
  if (c?.instagram_permalink_url) return c.instagram_permalink_url;
  if (c?.effective_object_story_id) return `https://www.facebook.com/${c.effective_object_story_id}`;
  if (ad?.preview_shareable_link) return ad.preview_shareable_link;
  return null;
}

// Resolve o link único de um ad (level "ad"). Falha de Graph → null (não derruba o envio).
async function resolveAdLink(nodeId: string, accessToken: string): Promise<string | null> {
  try {
    const url =
      `${GRAPH}/${encodeURIComponent(nodeId)}` +
      `?fields=preview_shareable_link,creative{instagram_permalink_url,effective_object_story_id}` +
      `&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      console.log("[notify-client-whatsapp] Graph ad link error:", JSON.stringify(data?.error ?? res.status));
      return null;
    }
    return pickLink(data);
  } catch (e) {
    console.log("[notify-client-whatsapp] Graph ad link exception:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// Resolve os ads ATIVOS de um adset (level "adset") com seus links.
// Falha de Graph → lista vazia (não derruba o envio).
async function resolveAdsetAds(
  adsetId: string,
  accessToken: string,
): Promise<{ name: string; link: string | null }[]> {
  try {
    // Filtra pelo `status` PRÓPRIO do ad, NÃO por `effective_status`: este fetch roda DEPOIS da
    // pausa do conjunto, então o effective_status de todos os ads já virou ADSET_PAUSED — mas o
    // status próprio (o que o gestor tinha ligado) segue ACTIVE. Assim listamos os criativos que
    // ESTAVAM ativos no conjunto (o requisito), não uma lista vazia.
    const url =
      `${GRAPH}/${encodeURIComponent(adsetId)}/ads` +
      `?fields=name,status,preview_shareable_link,creative{instagram_permalink_url,effective_object_story_id}` +
      `&limit=200&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error || !Array.isArray(data?.data)) {
      console.log("[notify-client-whatsapp] Graph adset ads error:", JSON.stringify(data?.error ?? res.status));
      return [];
    }
    return data.data
      .filter((ad: { status?: string }) => ad?.status === "ACTIVE")
      .map((ad: { name?: string }) => ({
        name: ad?.name ?? "(sem nome)",
        link: pickLink(ad),
      }));
  } catch (e) {
    console.log("[notify-client-whatsapp] Graph adset ads exception:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

// Resolve os ads que ESTAVAM ativos numa campanha inteira (level "campaign"), com seus links.
// Falha de Graph → lista vazia (não derruba o envio).
async function resolveCampaignAds(
  campaignId: string,
  accessToken: string,
): Promise<{ name: string; link: string | null }[]> {
  try {
    // MESMO cuidado do resolveAdsetAds: filtra pelo `status` PRÓPRIO do ad, NÃO por `effective_status`.
    // Este fetch roda DEPOIS de pausar a campanha, então o effective_status de TODOS os ads já virou
    // CAMPAIGN_PAUSED — filtrar por effective_status=ACTIVE (server-side) devolveria lista vazia. O
    // status próprio (o que o gestor tinha ligado) segue ACTIVE, então listamos os criativos que
    // ESTAVAM ativos na campanha (o requisito).
    const url =
      `${GRAPH}/${encodeURIComponent(campaignId)}/ads` +
      `?fields=name,status,preview_shareable_link,creative{instagram_permalink_url,effective_object_story_id}` +
      `&limit=200&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error || !Array.isArray(data?.data)) {
      console.log("[notify-client-whatsapp] Graph campaign ads error:", JSON.stringify(data?.error ?? res.status));
      return [];
    }
    return data.data
      .filter((ad: { status?: string }) => ad?.status === "ACTIVE")
      .map((ad: { name?: string }) => ({
        name: ad?.name ?? "(sem nome)",
        link: pickLink(ad),
      }));
  } catch (e) {
    console.log("[notify-client-whatsapp] Graph campaign ads exception:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

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
      console.log("[notify-client-whatsapp] Auth error:", authError?.message);
      return json({ error: "Sessão inválida" }, 401);
    }

    // 2. Validar body.
    const body = await req.json().catch(() => ({}));
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const adAccountId = typeof body.ad_account_id === "string" ? body.ad_account_id : "";
    const level =
      body.level === "adset" || body.level === "ad" || body.level === "campaign" ? body.level : "";
    const nodeId = typeof body.node_id === "string" ? body.node_id : "";
    const nodeName = typeof body.node_name === "string" ? body.node_name : "";
    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : "";
    const campaignName = typeof body.campaign_name === "string" ? body.campaign_name : "";
    const metricLabel = typeof body.metric_label === "string" ? body.metric_label : "";
    // Fail-safe: só envia quando dry_run é explicitamente false;
    // ausente/qualquer-outro-valor → preview (nunca dispara WhatsApp por acidente).
    const dryRun = body.dry_run !== false;

    if (!accessToken) return json({ error: "access_token obrigatório" }, 400);
    if (!adAccountId) return json({ error: "ad_account_id obrigatório" }, 400);
    if (!level) return json({ error: 'level deve ser "adset", "ad" ou "campaign"' }, 400);
    // Alvo por nível: adset/ad usam node_id/node_name; campaign usa campaign_id/campaign_name.
    if (level === "campaign") {
      if (!campaignId) return json({ error: "campaign_id obrigatório" }, 400);
      if (!campaignName) return json({ error: "campaign_name obrigatório" }, 400);
    } else {
      if (!nodeId) return json({ error: "node_id obrigatório" }, 400);
      if (!nodeName) return json({ error: "node_name obrigatório" }, 400);
    }
    if (!metricLabel) return json({ error: "metric_label obrigatório" }, 400);

    // 3. Resolver o grupo de WhatsApp do cliente (service-role, escopado ao caller).
    const svc = createClient(supabaseUrl, serviceRoleKey);
    const { data: mapping, error: mappingErr } = await svc
      .from("client_ad_accounts")
      .select("client_id")
      .eq("ad_account_id", adAccountId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (mappingErr) {
      console.log("[notify-client-whatsapp] client_ad_accounts error:", mappingErr.message);
      return json({ ok: false, reason: "cliente sem grupo de WhatsApp configurado" });
    }
    if (!mapping?.client_id) {
      return json({ ok: false, reason: "cliente sem grupo de WhatsApp configurado" });
    }

    const { data: client, error: clientErr } = await svc
      .from("clients")
      .select("name, whatsapp_group_id")
      .eq("id", mapping.client_id)
      .eq("user_id", user.id)
      .maybeSingle();

    const clientName = (client as { name?: string } | null)?.name ?? null;
    const groupId =
      client && typeof (client as { whatsapp_group_id?: string | null }).whatsapp_group_id === "string"
        ? (client as { whatsapp_group_id: string }).whatsapp_group_id
        : null;

    if (clientErr || !groupId) {
      if (clientErr) console.log("[notify-client-whatsapp] clients error:", clientErr.message);
      return json({ ok: false, reason: "cliente sem grupo de WhatsApp configurado" });
    }

    // 4. Resolver link(s) do criativo via Graph e compor a mensagem.
    let text: string;
    let links: string | null | { name: string; link: string | null }[];

    if (level === "ad") {
      const adLink = await resolveAdLink(nodeId, accessToken);
      links = adLink;
      text =
        `Desativamos o criativo *${nodeName}* por conta de *${metricLabel}* fora do KPI.` +
        (adLink ? `\n🔗 ${adLink}` : `\n(sem link público disponível)`);
    } else if (level === "campaign") {
      const ads = await resolveCampaignAds(campaignId, accessToken);
      links = ads;
      const lines = ads
        .map((ad) => `\n• ${ad.name}${ad.link ? ` — ${ad.link}` : " (sem link)"}`)
        .join("");
      text =
        `Desativamos a campanha *${campaignName}* e os criativos ativos dela, ` +
        `por conta de *${metricLabel}* fora do KPI.` +
        lines;
    } else {
      const ads = await resolveAdsetAds(nodeId, accessToken);
      links = ads;
      const lines = ads
        .map((ad) => `\n• ${ad.name}${ad.link ? ` — ${ad.link}` : " (sem link)"}`)
        .join("");
      text =
        `Desativamos o conjunto *${nodeName}* e os criativos ativos dele, ` +
        `por conta de *${metricLabel}* fora do KPI.` +
        lines;
    }

    // 5. dry_run → só preview, NUNCA envia. Devolve o destinatário (nome do cliente + group_id) pro
    // dialog de confirmação mostrar PRA QUEM vai — assim o gestor pega um grupo errado antes de enviar.
    if (dryRun) {
      return json({ ok: true, group_id: groupId, client_name: clientName, text, links });
    }

    // 6. Envio real via UAZAPI.
    const sent = await sendWhatsAppText({ groupId, text });
    if (!sent.ok) {
      console.log("[notify-client-whatsapp] Envio UAZAPI falhou:", sent.reason);
      return json({ ok: false, reason: sent.reason });
    }
    return json({ ok: true, sent: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[notify-client-whatsapp] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
