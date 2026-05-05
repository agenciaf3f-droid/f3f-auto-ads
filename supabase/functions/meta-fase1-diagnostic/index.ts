import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AD_FIELDS = [
  "id", "name", "status", "effective_status", "configured_status",
  "creative{id,name,status,effective_object_story_id,object_story_spec,asset_feed_spec,url_tags,call_to_action_type,thumbnail_url,image_url,video_id,link_url,body,title}",
  "adset_id", "campaign_id",
  "tracking_specs", "conversion_specs",
].join(",");

const ADSET_FIELDS = [
  "id", "name", "status", "effective_status", "configured_status",
  "optimization_goal", "billing_event", "bid_strategy", "bid_amount",
  "daily_budget", "lifetime_budget",
  "destination_type", "promoted_object",
  "targeting", "targeting_optimization_types",
  "attribution_spec", "start_time", "end_time",
  "is_dynamic_creative",
].join(",");

const CAMPAIGN_FIELDS = [
  "id", "name", "status", "effective_status", "configured_status",
  "objective", "buying_type", "bid_strategy",
  "daily_budget", "lifetime_budget",
  "special_ad_categories", "special_ad_category",
  "is_adset_budget_sharing_enabled",
  "smart_promotion_type",
].join(",");

async function fetchMeta(path: string, token: string) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://graph.facebook.com/v22.0/${path}${sep}access_token=${token}`);
  return res.json();
}

function deepDiff(a: any, b: any, path = ""): { path: string; good: any; bad: any }[] {
  const diffs: { path: string; good: any; bad: any }[] = [];
  if (a === b) return diffs;
  if (a === null || b === null || typeof a !== typeof b) {
    diffs.push({ path: path || "(root)", good: a, bad: b });
    return diffs;
  }
  if (typeof a !== "object") {
    if (a !== b) diffs.push({ path: path || "(root)", good: a, bad: b });
    return diffs;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    }
    return diffs;
  }
  const allKeys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of allKeys) {
    diffs.push(...deepDiff(a?.[key], b?.[key], path ? `${path}.${key}` : key));
  }
  return diffs;
}

function generateCauses(
  diffs: { campaign: any[]; adset: any[]; creative: any[]; ad: any[] },
  goodAd: any, badAd: any,
  goodCreative: any, badCreative: any,
  goodAdset: any, badAdset: any
): string[] {
  const causes: string[] = [];

  // Check creative diffs
  for (const d of diffs.creative) {
    if (d.path.includes("call_to_action_type")) {
      causes.push(`CTA diferente: bom="${d.good}", ruim="${d.bad}" — pode ser incompatível com objetivo`);
    }
    if (d.path.includes("link_url") || d.path.includes("website_url")) {
      causes.push(`Link/URL diferente no criativo: bom="${d.good}", ruim="${d.bad}" — website_url em anúncio de perfil causa #1346001`);
    }
    if (d.path.includes("url_tags")) {
      causes.push(`url_tags (UTMs) diferente: bom="${d.good}", ruim="${d.bad}" — UTMs incompatíveis com VISIT_PROFILE`);
    }
    if (d.path.includes("object_story_spec") || d.path.includes("effective_object_story_id")) {
      causes.push(`Estrutura do criativo (object_story) diferente: campo "${d.path}"`);
    }
    if (d.path.includes("asset_feed_spec")) {
      causes.push(`asset_feed_spec diferente: campo "${d.path}" — pode indicar dynamic creative inconsistente`);
    }
  }

  // Check ad diffs
  for (const d of diffs.ad) {
    if (d.path.includes("tracking_specs")) {
      causes.push(`tracking_specs diferente: bom=${JSON.stringify(d.good)}, ruim=${JSON.stringify(d.bad)}`);
    }
    if (d.path.includes("conversion_specs")) {
      causes.push(`conversion_specs diferente — pode forçar pixel/evento incompatível`);
    }
  }

  // Check adset diffs
  for (const d of diffs.adset) {
    if (d.path.includes("promoted_object")) {
      causes.push(`promoted_object diferente: campo "${d.path}" — bom=${JSON.stringify(d.good)}, ruim=${JSON.stringify(d.bad)}`);
    }
    if (d.path.includes("destination_type")) {
      causes.push(`destination_type diferente: bom="${d.good}", ruim="${d.bad}"`);
    }
    if (d.path.includes("optimization_goal")) {
      causes.push(`optimization_goal diferente: bom="${d.good}", ruim="${d.bad}"`);
    }
    if (d.path.includes("targeting_optimization")) {
      causes.push(`advantage_audience / targeting_optimization diferente`);
    }
  }

  // Check for known #1346001 patterns
  const badCreativeSpec = badCreative?.object_story_spec;
  if (badCreativeSpec) {
    const hasLink = badCreativeSpec?.link_data?.link || badCreativeSpec?.video_data?.call_to_action?.value?.link;
    if (hasLink && goodAdset?.destination_type === "INSTAGRAM_PROFILE") {
      causes.push(`HIPÓTESE FORTE: criativo ruim tem link/URL mas destino é INSTAGRAM_PROFILE — conflito clássico do #1346001`);
    }
  }

  // Check effective_status
  if (badAd?.effective_status === "WITH_ISSUES" || badAd?.effective_status === "DISAPPROVED") {
    causes.push(`Ad ruim tem effective_status="${badAd.effective_status}" — confirma rejeição pós-publicação`);
  }

  if (causes.length === 0) {
    causes.push("Nenhuma diferença óbvia encontrada — o erro pode ser de revisão de conteúdo (policy) e não de estrutura");
    causes.push("Verificar se o conteúdo do vídeo/imagem viola políticas de anúncios da Meta");
    causes.push("Verificar se a conta de anúncios tem restrições ativas");
  }

  return causes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, good_ad_id, bad_ad_id, ad_account_id } = await req.json();

    if (!access_token || !good_ad_id || !bad_ad_id) {
      return new Response(JSON.stringify({
        ok: false,
        error: "Campos obrigatórios: access_token, good_ad_id, bad_ad_id",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[fase1-diag] Comparing good=${good_ad_id} vs bad=${bad_ad_id}`);

    // Fetch both ads in parallel
    const [goodAdRaw, badAdRaw] = await Promise.all([
      fetchMeta(`${good_ad_id}?fields=${AD_FIELDS}`, access_token),
      fetchMeta(`${bad_ad_id}?fields=${AD_FIELDS}`, access_token),
    ]);

    if (goodAdRaw.error || badAdRaw.error) {
      return new Response(JSON.stringify({
        ok: false,
        error: "Erro ao buscar anúncios",
        good_error: goodAdRaw.error || null,
        bad_error: badAdRaw.error || null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[fase1-diag] good_ad: ${JSON.stringify(goodAdRaw)}`);
    console.log(`[fase1-diag] bad_ad: ${JSON.stringify(badAdRaw)}`);

    // Fetch adsets and campaigns in parallel
    const [goodAdset, badAdset, goodCampaign, badCampaign] = await Promise.all([
      fetchMeta(`${goodAdRaw.adset_id}?fields=${ADSET_FIELDS}`, access_token),
      fetchMeta(`${badAdRaw.adset_id}?fields=${ADSET_FIELDS}`, access_token),
      fetchMeta(`${goodAdRaw.campaign_id}?fields=${CAMPAIGN_FIELDS}`, access_token),
      fetchMeta(`${badAdRaw.campaign_id}?fields=${CAMPAIGN_FIELDS}`, access_token),
    ]);

    console.log(`[fase1-diag] good_adset: ${JSON.stringify(goodAdset)}`);
    console.log(`[fase1-diag] bad_adset: ${JSON.stringify(badAdset)}`);
    console.log(`[fase1-diag] good_campaign: ${JSON.stringify(goodCampaign)}`);
    console.log(`[fase1-diag] bad_campaign: ${JSON.stringify(badCampaign)}`);

    // Extract creatives
    const goodCreative = goodAdRaw.creative || {};
    const badCreative = badAdRaw.creative || {};

    console.log(`[fase1-diag] good_creative: ${JSON.stringify(goodCreative)}`);
    console.log(`[fase1-diag] bad_creative: ${JSON.stringify(badCreative)}`);

    // Compute diffs
    const campaignDiff = deepDiff(goodCampaign, badCampaign);
    const adsetDiff = deepDiff(goodAdset, badAdset);
    const creativeDiff = deepDiff(goodCreative, badCreative);
    const adDiff = deepDiff(
      { ...goodAdRaw, creative: undefined },
      { ...badAdRaw, creative: undefined }
    );

    const allDiffs = {
      campaign: campaignDiff,
      adset: adsetDiff,
      creative: creativeDiff,
      ad: adDiff,
    };

    console.log(`[fase1-diag] DIFFS: ${JSON.stringify(allDiffs)}`);

    // Generate diagnosis
    const possibleCauses = generateCauses(
      allDiffs, goodAdRaw, badAdRaw,
      goodCreative, badCreative,
      goodAdset, badAdset
    );

    console.log(`[fase1-diag] POSSIBLE CAUSES: ${JSON.stringify(possibleCauses)}`);

    const result = {
      ok: true,
      good_ad: {
        ad: goodAdRaw,
        adset: goodAdset,
        campaign: goodCampaign,
        creative: goodCreative,
      },
      bad_ad: {
        ad: badAdRaw,
        adset: badAdset,
        campaign: badCampaign,
        creative: badCreative,
      },
      diffs: allDiffs,
      diff_summary: {
        campaign_diffs: campaignDiff.length,
        adset_diffs: adsetDiff.length,
        creative_diffs: creativeDiff.length,
        ad_diffs: adDiff.length,
        total: campaignDiff.length + adsetDiff.length + creativeDiff.length + adDiff.length,
      },
      possible_causes: possibleCauses,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(`[fase1-diag] ERROR: ${e.message}`);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
