import { supabase } from "@/integrations/supabase/client";
import type { DateRangeSelection } from "@/lib/meta-insights";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export function getMetaLoginUrl(state?: string) {
  const base = `${SUPABASE_URL}/functions/v1/meta-login`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

export async function exchangeCodeForToken(code: string, redirectUri?: string) {
  const { data, error } = await supabase.functions.invoke("meta-oauth-callback", {
    body: { code, redirect_uri: redirectUri || `${window.location.origin}/auth/meta/callback` },
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function fetchMetaStatus() {
  const { data, error } = await supabase.functions.invoke("meta-status");
  if (error) throw new Error(error.message);
  return data as { connected: boolean; access_token?: string; meta_name?: string; expires_at?: string; expires_soon?: boolean; reason?: string };
}

export async function disconnectMeta() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Não autenticado");
  // SHARED CONNECTION MODEL: só admin consegue desconectar (RLS no banco impede o resto).
  const { data: adminRow } = await supabase
    .from("app_admins")
    .select("user_id")
    .maybeSingle();
  if (!adminRow) throw new Error("Apenas admins podem desconectar a conta Meta da agência.");
  const { error } = await supabase.from("meta_connections").delete().eq("user_id", adminRow.user_id);
  if (error) throw new Error(error.message);
  sessionStorage.removeItem("meta_status_cache");
  sessionStorage.removeItem(AD_ACCOUNTS_CACHE_KEY);
}

const AD_ACCOUNTS_CACHE_KEY = "meta_ad_accounts_cache";

export async function fetchAdAccounts(accessToken: string) {
  try {
    const cached = sessionStorage.getItem(AD_ACCOUNTS_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      const cacheAge = Date.now() - (parsed._cachedAt || 0);
      // Cache válido por 5 minutos, mesmo padrão do meta_status_cache
      if (cacheAge < 5 * 60 * 1000 && parsed.access_token === accessToken && Array.isArray(parsed.accounts)) {
        return parsed.accounts;
      }
    }
  } catch {
    // cache corrompido ou sessionStorage indisponível (modo privado) — segue pro fetch normal
  }

  const { data, error } = await supabase.functions.invoke("meta-ad-accounts", {
    body: { access_token: accessToken },
  });
  if (error) throw new Error(error.message);
  const accounts = data?.accounts || [];

  try {
    sessionStorage.setItem(AD_ACCOUNTS_CACHE_KEY, JSON.stringify({ access_token: accessToken, accounts, _cachedAt: Date.now() }));
  } catch {
    // quota/modo privado — não impede o uso, só não cacheia
  }

  return accounts;
}

export async function fetchIgAccountsForAdAccount(accessToken: string, adAccountId: string) {
  const { data, error } = await supabase.functions.invoke("meta-ad-accounts", {
    body: { access_token: accessToken, action: "get_ig_accounts", ad_account_id: adAccountId },
  });
  if (error) throw new Error(error.message);
  return { ig_accounts: data?.ig_accounts || [], diagnostic: data?.diagnostic || [], dsa_beneficiary: data?.dsa_beneficiary || null };
}

export async function fetchAudiences(accessToken: string, adAccountId: string) {
  const { data, error } = await supabase.functions.invoke("meta-audiences", {
    body: { access_token: accessToken, ad_account_id: adAccountId },
  });
  if (error) throw new Error(error.message);
  return data?.audiences || [];
}

export type ImportedMetaTemplate = {
  key: string;
  template_id: string;
  welcome_text: string;
  autofill: string;
  quick_reply: string | null;
  sample_ad_name: string;
  raw_json: string;
};

export async function fetchImportedMetaTemplates(accessToken: string, adAccountId: string) {
  const { data, error } = await supabase.functions.invoke("meta-message-templates", {
    body: { access_token: accessToken, ad_account_id: adAccountId },
  });
  if (error) throw new Error(error.message);
  return {
    templates: (data?.templates || []) as ImportedMetaTemplate[],
    scanned_adsets: (data?.scanned_adsets ?? 0) as number,
    errors_during_scan: (data?.errors_during_scan ?? 0) as number,
    error_sample: (data?.error_sample ?? null) as string | null,
    error_summary: (data?.error_summary ?? null) as string | null,
  };
}

export type AdPixel = { id: string; name: string; creation_time?: string };

export async function fetchPixels(accessToken: string, adAccountId: string) {
  const { data, error } = await supabase.functions.invoke("meta-pixels", {
    body: { access_token: accessToken, ad_account_id: adAccountId },
  });
  if (error) throw new Error(error.message);
  return (data?.pixels || []) as AdPixel[];
}

export async function validatePublish(params: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("meta-publish-validate", {
    body: params,
  });
  if (error && data) return data;
  if (error) throw new Error(error.message);
  return data;
}

export async function validateCreative(params: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("meta-validate-creative", {
    body: params,
  });
  if (error && data) return data;
  if (error) throw new Error(error.message);
  return data;
}

export async function fetchCampaigns(accessToken: string, adAccountId: string) {
  const { data, error } = await supabase.functions.invoke("meta-campaigns", {
    body: { access_token: accessToken, ad_account_id: adAccountId },
  });
  if (error) throw new Error(error.message);
  return data?.campaigns || [];
}

export async function fetchCampaignInsights(
  accessToken: string,
  campaignIds: string[],
  range?: DateRangeSelection,
) {
  const body: Record<string, unknown> = { access_token: accessToken, campaign_ids: campaignIds };
  if (range) {
    if (range.mode === "custom") {
      body.since = range.since;
      body.until = range.until;
    } else {
      body.date_preset = range.preset;
    }
  }
  const { data, error } = await supabase.functions.invoke("meta-campaign-insights", { body });
  if (error && data) return data;
  if (error) throw new Error(error.message);
  return data?.insights || {};
}

export type MetaNodeInsight = {
  id: string;
  name: string;
  effective_status: string;
  spend: number;
  impressions: number;
  clicks: number;
  actionCounts: Record<string, number>;
  vv95: number;
  // Só presente no level "ad" — id do adset dono do criativo. Permite filtrar os criativos de
  // um conjunto específico no drill-in do OptimizationBoard sem outra chamada.
  adsetId?: string;
};

export async function fetchNodeInsights(
  accessToken: string,
  campaignId: string,
  level: "adset" | "ad",
  range?: DateRangeSelection,
): Promise<MetaNodeInsight[]> {
  const body: Record<string, unknown> = { access_token: accessToken, campaign_id: campaignId, level };
  if (range) {
    if (range.mode === "custom") {
      body.since = range.since;
      body.until = range.until;
    } else {
      body.date_preset = range.preset;
    }
  }
  const { data, error } = await supabase.functions.invoke("meta-node-insights", { body });
  if (error && data) throw new Error(data.error || error.message);
  if (error) throw new Error(error.message);
  return (data?.nodes || []) as MetaNodeInsight[];
}

export async function pauseCampaign(accessToken: string, campaignId: string) {
  const { data, error } = await supabase.functions.invoke("meta-campaign-pause", {
    body: { access_token: accessToken, campaign_id: campaignId },
  });
  if (error && data) return data;
  if (error) throw new Error(error.message);
  return data;
}

export async function fetchWhatsAppNumbers(accessToken: string, adAccountId?: string, pageId?: string) {
  const { data, error } = await supabase.functions.invoke("meta-whatsapp-numbers", {
    body: { access_token: accessToken, ad_account_id: adAccountId, page_id: pageId },
  });
  if (error) throw new Error(error.message);
  return { numbers: data?.numbers || [], error_summary: data?.error_summary || null };
}

export interface LocationResult {
  key: string;
  name: string;
  type: string;
  country_code: string;
  country_name: string;
  region?: string;
  display: string;
}

export async function searchLocations(accessToken: string, query: string): Promise<LocationResult[]> {
  const { data, error } = await supabase.functions.invoke("meta-location-search", {
    body: { access_token: accessToken, query },
  });
  if (error) throw new Error(error.message);
  return data?.locations || [];
}

export async function publishAd(params: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("meta-publish", {
    body: params,
  });
  if (error && data) return data;
  if (error) {
    try {
      const parsed = typeof error === "string" ? JSON.parse(error) : error;
      if (parsed.error_message || parsed.step) return { ok: false, ...parsed };
    } catch {}
    throw new Error(error.message || "Erro ao publicar");
  }
  return data;
}

export async function runFase3Diagnostic(params: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("meta-fase3-diagnostic", {
    body: params,
  });
  if (error && data) return data;
  if (error) throw new Error(error.message || "Erro no diagnóstico");
  return data;
}

export async function runCampaignDiagnostic(accessToken: string, adAccountId: string) {
  const { data, error } = await supabase.functions.invoke("meta-campaign-diagnostic", {
    body: { access_token: accessToken, ad_account_id: adAccountId },
  });
  if (error && data) return data;
  if (error) throw new Error(error.message || "Erro no diagnóstico de campanhas");
  return data;
}

export async function runFase1Diagnostic(params: { access_token: string; good_ad_id: string; bad_ad_id: string; ad_account_id?: string }) {
  const { data, error } = await supabase.functions.invoke("meta-fase1-diagnostic", {
    body: params,
  });
  if (error && data) return data;
  if (error) throw new Error(error.message || "Erro no diagnóstico FASE 1");
  return data;
}

export async function runAdsetDiff(params: { access_token: string; ad_account_id: string; app_adset_payload?: Record<string, unknown> }) {
  const { data, error } = await supabase.functions.invoke("meta-adset-diff", {
    body: params,
  });
  if (error && data) return data;
  if (error) throw new Error(error.message || "Erro no diff de adset");
  return data;
}

export type NotifyClientPauseParams = {
  access_token: string;
  ad_account_id: string;
  level: "adset" | "ad";
  node_id: string;
  adset_id?: string;
  node_name: string;
  metric_label: string;
  dry_run: boolean;
};

export type NotifyClientPauseResult =
  | { ok: true; group_id: string; client_name: string | null; text: string; links: unknown }
  | { ok: true; sent: true }
  | { ok: false; reason: string };

export async function notifyClientPause(params: NotifyClientPauseParams): Promise<NotifyClientPauseResult> {
  const { data, error } = await supabase.functions.invoke("notify-client-whatsapp", {
    body: params,
  });
  if (error) throw new Error(error.message);
  return data as NotifyClientPauseResult;
}
