import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const API_VERSION = "v22.0";

// Exhaustive field lists — request EVERYTHING the API can return
const CAMPAIGN_FIELDS = [
  "id","name","status","effective_status","objective","buying_type","bid_strategy",
  "budget_remaining","daily_budget","lifetime_budget","spend_cap",
  "start_time","stop_time","created_time","updated_time",
  "special_ad_categories","special_ad_category","special_ad_category_country",
  "configured_status","can_use_spend_cap","can_create_brand_lift_study",
  "budget_rebalance_flag","is_skadnetwork_attribution","smart_promotion_type",
  "source_campaign_id","topline_id","promoted_object",
  "pacing_type","adbatch","adlabels","boosted_object_id",
  "issues_info","recommendations","execution_options",
];

const ADSET_FIELDS = [
  "id","name","status","effective_status","campaign_id",
  "daily_budget","lifetime_budget","budget_remaining",
  "optimization_goal","optimization_sub_event",
  "billing_event","bid_amount","bid_strategy","bid_adjustments",
  "destination_type","promoted_object",
  "targeting","attribution_spec","conversion_domain",
  "start_time","end_time","created_time","updated_time",
  "configured_status","is_dynamic_creative",
  "pacing_type","frequency_control_specs",
  "rf_prediction_id","use_new_app_click",
  "adlabels","adset_schedule","asset_feed_id",
  "campaign","contextual_bundling_spec","creative_sequence",
  "daily_min_spend_target","daily_spend_cap",
  "existing_customer_budget_percentage",
  "instagram_actor_id","issues_info",
  "learning_stage_info","lifetime_min_spend_target","lifetime_spend_cap",
  "multi_optimization_goal_weight","tune_for_category",
  "recurring_budget_semantics","review_feedback",
  "source_adset_id","time_based_ad_rotation_id_blocks","time_based_ad_rotation_intervals",
];

const AD_FIELDS = [
  "id","name","status","effective_status","adset_id","campaign_id",
  "creative","tracking_specs","conversion_specs",
  "configured_status","created_time","updated_time",
  "bid_amount","last_updated_by_app_id",
  "source_ad_id","adlabels","issues_info","recommendations",
  "demolink_hash","display_sequence","engagement_audience",
  "priority","audience_id",
];

const CREATIVE_FIELDS = [
  "id","name","status","title","body","image_hash","image_url",
  "thumbnail_url","url_tags","link_url","object_url",
  "object_story_id","object_story_spec","object_type",
  "call_to_action_type","effective_object_story_id",
  "instagram_actor_id","instagram_permalink_url","instagram_story_id","instagram_user_id",
  "source_instagram_media_id","video_id",
  "asset_feed_spec","applink_treatment","authorization_category",
  "branded_content","branded_content_sponsor_page_id",
  "bundle_folder_id","categorization_criteria",
  "category_media_source","collaborative_ads_lsb_image_bank_id",
  "contextual_multi_ads","creative_sourcing_spec",
  "degrees_of_freedom_spec","destination_set_id",
  "dynamic_ad_voice","effective_authorization_category",
  "effective_instagram_media_id","effective_instagram_story_id",
  "image_crops","image_file","interactive_components_spec",
  "link_deep_link_url","link_destination_display_url","link_og_id",
  "messenger_sponsored_message","object_id",
  "playable_asset_id","portrait_customizations",
  "place_page_set_id","platform_customizations",
  "product_set_id","recommender_settings",
  "referral_id","template_url","template_url_spec",
  "use_page_actor_override",
];

/**
 * Resilient fetch: if the API returns error 100 (invalid fields),
 * retry by removing the offending field(s) automatically.
 */
async function resilientFetchWithFields(
  baseUrl: string,
  fields: string[],
  accessToken: string,
  entityLabel: string,
  logs: string[],
): Promise<any[]> {
  let currentFields = [...fields];
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    const fieldsStr = currentFields.join(",");
    const separator = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${separator}fields=${fieldsStr}&limit=100&access_token=${accessToken}`;

    const all: any[] = [];
    let nextUrl: string | null = url;
    let pageCount = 0;

    while (nextUrl && pageCount < 20) {
      const res = await fetch(nextUrl);
      const data = await res.json();

      if (data.error) {
        const errMsg = data.error.message || "";
        const errCode = data.error.code;

        // Error 100 = invalid field — remove it and retry
        if (errCode === 100) {
          const fieldMatch = errMsg.match(/field\s+'?([a-z_]+)'?/i) ||
                             errMsg.match(/#100.*?['"]([a-z_]+)['"]/i);
          if (fieldMatch) {
            const badField = fieldMatch[1];
            logs.push(`⚠️ [${entityLabel}] Campo '${badField}' inválido, removendo e tentando novamente (tentativa ${attempts})`);
            currentFields = currentFields.filter(f => f !== badField);
            break; // break inner loop to retry
          }
        }

        // Other errors — log and return what we have
        logs.push(`❌ [${entityLabel}] API error: ${JSON.stringify(data.error)}`);
        return all;
      }

      if (data.data) all.push(...data.data);
      nextUrl = data.paging?.next || null;
      pageCount++;
    }

    // If we completed pagination without breaking, return results
    if (all.length > 0 || attempts >= maxAttempts) {
      if (attempts > 1) {
        logs.push(`✅ [${entityLabel}] Sucesso após ${attempts} tentativa(s), ${currentFields.length} campos`);
      }
      return all;
    }

    // If all is empty and we didn't break due to field error, return empty
    if (attempts > 1 && all.length === 0) {
      return all;
    }
  }

  logs.push(`⚠️ [${entityLabel}] Esgotou tentativas de resilient fetch`);
  return [];
}

/**
 * Fetch a single entity (like a creative) with resilient field removal.
 */
async function resilientFetchSingle(
  baseUrl: string,
  fields: string[],
  accessToken: string,
  entityLabel: string,
  logs: string[],
): Promise<any | null> {
  let currentFields = [...fields];
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    const fieldsStr = currentFields.join(",");
    const separator = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${separator}fields=${fieldsStr}&access_token=${accessToken}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      const errMsg = data.error.message || "";
      const errCode = data.error.code;

      if (errCode === 100) {
        const fieldMatch = errMsg.match(/field\s+'?([a-z_]+)'?/i) ||
                           errMsg.match(/#100.*?['"]([a-z_]+)['"]/i);
        if (fieldMatch) {
          const badField = fieldMatch[1];
          logs.push(`⚠️ [${entityLabel}] Campo '${badField}' inválido, removendo (tentativa ${attempts})`);
          currentFields = currentFields.filter(f => f !== badField);
          continue;
        }
      }

      logs.push(`❌ [${entityLabel}] API error: ${JSON.stringify(data.error)}`);
      return { _error: data.error };
    }

    if (attempts > 1) {
      logs.push(`✅ [${entityLabel}] Sucesso após ${attempts} tentativa(s)`);
    }
    return data;
  }

  logs.push(`⚠️ [${entityLabel}] Esgotou tentativas`);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id } = await req.json();
    if (!access_token || !ad_account_id) {
      return new Response(JSON.stringify({ ok: false, error: "access_token and ad_account_id required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const logs: string[] = [];
    console.log(`[diagnostic] Starting full diagnostic for ${ad_account_id}`);
    logs.push(`Iniciando diagnóstico completo para ${ad_account_id}`);

    // 1. Fetch ALL campaigns (ACTIVE + PAUSED)
    const campaignsBaseUrl = `https://graph.facebook.com/${API_VERSION}/${ad_account_id}/campaigns?filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]`;
    const campaigns = await resilientFetchWithFields(campaignsBaseUrl, CAMPAIGN_FIELDS, access_token, "campaigns", logs);
    logs.push(`Encontradas ${campaigns.length} campanha(s)`);

    const results: any[] = [];

    for (const campaign of campaigns) {
      const entry: any = {
        campaign,
        adsets: [],
        ads: [],
        creatives: [],
        _errors: [],
      };

      // Fetch adsets via campaign edge
      try {
        const adsetsBaseUrl = `https://graph.facebook.com/${API_VERSION}/${campaign.id}/adsets?`;
        entry.adsets = await resilientFetchWithFields(adsetsBaseUrl, ADSET_FIELDS, access_token, `adsets(campaign=${campaign.id})`, logs);
        logs.push(`📦 [adsets] Edge retornou ${entry.adsets.length} adset(s) para campanha ${campaign.id}`);
      } catch (e: any) {
        entry._errors.push({ step: "adsets_edge", error: e.message });
        logs.push(`❌ Erro ao buscar adsets via edge da campanha ${campaign.id}: ${e.message}`);
      }

      // Fetch ads
      try {
        const adsBaseUrl = `https://graph.facebook.com/${API_VERSION}/${campaign.id}/ads?`;
        entry.ads = await resilientFetchWithFields(adsBaseUrl, AD_FIELDS, access_token, `ads(campaign=${campaign.id})`, logs);
      } catch (e: any) {
        entry._errors.push({ step: "ads", error: e.message });
        logs.push(`❌ Erro ao buscar ads da campanha ${campaign.id}: ${e.message}`);
      }

      // Fallback: resolve adsets individually from ad.adset_id when edge returned empty
      const knownAdsetIds = new Set(entry.adsets.map((a: any) => a.id));
      const missingAdsetIds = new Set<string>();
      for (const ad of entry.ads) {
        if (ad.adset_id && !knownAdsetIds.has(ad.adset_id)) {
          missingAdsetIds.add(ad.adset_id);
        }
      }
      if (missingAdsetIds.size > 0) {
        logs.push(`🔍 [adsets] ${missingAdsetIds.size} adset(s) referenciado(s) por ads mas ausente(s) no edge — buscando individualmente`);
        for (const adsetId of missingAdsetIds) {
          try {
            const adsetBaseUrl = `https://graph.facebook.com/${API_VERSION}/${adsetId}?`;
            const adsetData = await resilientFetchSingle(adsetBaseUrl, ADSET_FIELDS, access_token, `adset(${adsetId})`, logs);
            if (adsetData && !adsetData._error) {
              entry.adsets.push(adsetData);
              logs.push(`✅ [adset] Resolvido individualmente: ${adsetId}`);
            } else {
              entry.adsets.push({ id: adsetId, _error: adsetData?._error || "Não encontrado" });
              logs.push(`⚠️ [adset] Falha ao resolver ${adsetId}: ${JSON.stringify(adsetData?._error)}`);
            }
          } catch (e: any) {
            entry._errors.push({ step: `adset_${adsetId}`, error: e.message });
            entry.adsets.push({ id: adsetId, _error: e.message });
            logs.push(`❌ [adset] Erro ao buscar ${adsetId}: ${e.message}`);
          }
        }
      }

      // Fetch creative details for each ad
      const creativeIds = new Set<string>();
      for (const ad of entry.ads) {
        if (ad.creative?.id) creativeIds.add(ad.creative.id);
      }
      for (const cid of creativeIds) {
        try {
          const crBaseUrl = `https://graph.facebook.com/${API_VERSION}/${cid}?`;
          const crData = await resilientFetchSingle(crBaseUrl, CREATIVE_FIELDS, access_token, `creative(${cid})`, logs);
          if (crData) entry.creatives.push(crData);
        } catch (e: any) {
          entry._errors.push({ step: `creative_${cid}`, error: e.message });
          entry.creatives.push({ id: cid, _error: e.message });
          logs.push(`❌ Erro ao buscar creative ${cid}: ${e.message}`);
        }
      }

      if (entry._errors.length === 0) delete entry._errors;
      results.push(entry);
    }

    logs.push(`Diagnóstico completo. ${results.length} campanha(s) processada(s).`);
    console.log(`[diagnostic] Complete. ${results.length} campaigns processed.`);

    return new Response(JSON.stringify({
      ok: true,
      total_campaigns: results.length,
      diagnostic: results,
      logs,
      fetched_at: new Date().toISOString(),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error(`[diagnostic] Error: ${e.message}`);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
