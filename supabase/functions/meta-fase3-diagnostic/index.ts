import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * FASE 3 Diagnostic Edge Function
 * 
 * Tests different promoted_object configurations against the Meta API
 * to discover the minimum valid adset payload for WhatsApp campaigns.
 * 
 * Does NOT create real campaigns — creates a test campaign (PAUSED),
 * tries adset variations, logs everything, then cleans up.
 */

interface DiagnosticResult {
  attempt: string;
  promoted_object: Record<string, any>;
  full_payload: Record<string, any>;
  success: boolean;
  adset_id?: string;
  meta_response?: Record<string, any>;
  error?: {
    message: string;
    code: number | null;
    subcode: number | null;
    user_title: string;
    user_msg: string;
    raw: any;
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      access_token,
      ad_account_id,
      page_id,
      whatsapp_number_id,    // e.g. "874629542393718" (phone_number_id from WABA)
      whatsapp_phone_display, // e.g. "+55 11 94788-4996" (display format)
      audience_id,
      audience_type,
      targeting_spec,
    } = body;

    const results: DiagnosticResult[] = [];
    const logs: string[] = [];

    // ===== LOG INPUT ANALYSIS =====
    logs.push(`═══ FASE 3 DIAGNOSTIC START ═══`);
    logs.push(`ad_account_id: ${ad_account_id}`);
    logs.push(`page_id: ${page_id}`);
    logs.push(`whatsapp_number_id: ${whatsapp_number_id} (type: ${typeof whatsapp_number_id})`);
    logs.push(`whatsapp_phone_display: ${whatsapp_phone_display}`);
    logs.push(`audience_id: ${audience_id}`);
    logs.push(`audience_type: ${audience_type}`);

    logs.push(`policy: controlled test on WhatsApp linkage block only (no automatic account-link interpretation)`);

    // ===== CREATE TEST CAMPAIGN =====
    logs.push(`═══ CREATING TEST CAMPAIGN ═══`);
    const campaignPayload = {
      name: `[DIAGNOSTIC] FASE3 Test ${new Date().toISOString()}`,
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      buying_type: "AUCTION",
      special_ad_categories: [],
      access_token,
    };

    const campaignRes = await fetch(`https://graph.facebook.com/v22.0/${ad_account_id}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(campaignPayload),
    });
    const campaignData = await campaignRes.json();
    if (campaignData.error) {
      logs.push(`❌ Campaign creation failed: ${JSON.stringify(campaignData.error)}`);
      return new Response(JSON.stringify({ ok: false, error: "Campaign creation failed", detail: campaignData.error, logs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const campaignId = campaignData.id;
    logs.push(`✅ Test campaign created: ${campaignId}`);

    // ===== BUILD TARGETING (identical to meta-publish FASE 3) =====
    let targeting: Record<string, any>;
    if (audience_type === "saved" && targeting_spec) {
      targeting = { ...targeting_spec };
      delete targeting.targeting_optimization;
    } else {
      targeting = {
        custom_audiences: [{ id: audience_id }],
        geo_locations: { countries: ["BR"] },
      };
    }

    // FIXED structure (never remove)
    targeting.age_min = 18;
    targeting.age_max = 65;
    targeting.age_range = [18, 65];
    targeting.user_age_unknown = false;
    if (!targeting.geo_locations) targeting.geo_locations = { countries: ["BR"] };
    targeting.geo_locations.location_types = ["home", "recent"];
    targeting.brand_safety_content_filter_levels = ["FACEBOOK_RELAXED", "AN_RELAXED"];
    targeting.targeting_automation = {
      advantage_audience: 1,
    };

    const attribution_spec = [{ event_type: "CLICK_THROUGH", window_days: 1 }];

    // ===== DEFINE ATTEMPTS =====
    const internalPhoneId = String(whatsapp_number_id || "");
    const cleanPhone = String(whatsapp_phone_display || "").replace(/\D/g, "");

    const fullPromotedObject: Record<string, any> = {
      page_id,
      smart_pse_enabled: false,
      whats_app_business_phone_number_id: internalPhoneId,
      whatsapp_phone_number: cleanPhone,
    };

    const pickPromotedObject = (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const key of keys) {
        if (fullPromotedObject[key] !== undefined && fullPromotedObject[key] !== "") {
          out[key] = fullPromotedObject[key];
        }
      }
      return out;
    };

    const attempts: { name: string; promoted_object: Record<string, any> }[] = [
      {
        name: "A: control (all whatsapp linkage fields)",
        promoted_object: pickPromotedObject([
          "page_id",
          "smart_pse_enabled",
          "whats_app_business_phone_number_id",
          "whatsapp_phone_number",
        ]),
      },
      {
        name: "B: remove only smart_pse_enabled",
        promoted_object: pickPromotedObject([
          "page_id",
          "whats_app_business_phone_number_id",
          "whatsapp_phone_number",
        ]),
      },
      {
        name: "C: remove only whatsapp_phone_number",
        promoted_object: pickPromotedObject([
          "page_id",
          "smart_pse_enabled",
          "whats_app_business_phone_number_id",
        ]),
      },
      {
        name: "D: remove only whats_app_business_phone_number_id",
        promoted_object: pickPromotedObject([
          "page_id",
          "smart_pse_enabled",
          "whatsapp_phone_number",
        ]),
      },
      {
        name: "E: minimal strict (page_id + whats_app_business_phone_number_id)",
        promoted_object: pickPromotedObject([
          "page_id",
          "whats_app_business_phone_number_id",
        ]),
      },
    ];

    // ===== RUN ATTEMPTS =====
    const createdAdsetIds: string[] = [];

    for (const attempt of attempts) {
      logs.push(`═══ ATTEMPT: ${attempt.name} ═══`);
      logs.push(`promoted_object: ${JSON.stringify(attempt.promoted_object)}`);
      logs.push(`whatsapp_linkage_presence: page_id=${attempt.promoted_object.page_id !== undefined}, smart_pse_enabled=${attempt.promoted_object.smart_pse_enabled !== undefined}, whats_app_business_phone_number_id=${attempt.promoted_object.whats_app_business_phone_number_id !== undefined}, whatsapp_phone_number=${attempt.promoted_object.whatsapp_phone_number !== undefined}`);

      const adsetPayload: Record<string, any> = {
        name: `[DIAG] ${attempt.name}`,
        campaign_id: campaignId,
        billing_event: "IMPRESSIONS",
        optimization_goal: "CONVERSATIONS",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        targeting,
        status: "PAUSED",
        destination_type: "WHATSAPP",
        promoted_object: attempt.promoted_object,
        attribution_spec,
        daily_budget: "600", // R$6/day minimum (string per Meta API)
        start_time: new Date().toISOString(),
        access_token,
      };

      // Log sanitized payload (no access_token)
      const sanitized = { ...adsetPayload };
      delete sanitized.access_token;
      logs.push(`full_payload: ${JSON.stringify(sanitized)}`);

      const adsetRes = await fetch(`https://graph.facebook.com/v22.0/${ad_account_id}/adsets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(adsetPayload),
      });
      const adsetData = await adsetRes.json();
      logs.push(`meta_response_raw: ${JSON.stringify(adsetData)}`);

      if (adsetData.error) {
        logs.push(`❌ FAILED: code=${adsetData.error.code}, subcode=${adsetData.error.error_subcode}`);
        logs.push(`   message: ${adsetData.error.message}`);
        logs.push(`   user_title: ${adsetData.error.error_user_title || "N/A"}`);
        logs.push(`   user_msg: ${adsetData.error.error_user_msg || "N/A"}`);
        logs.push(`   full_error: ${JSON.stringify(adsetData.error)}`);
        results.push({
          attempt: attempt.name,
          promoted_object: attempt.promoted_object,
          full_payload: sanitized,
          success: false,
          meta_response: adsetData,
          error: {
            message: adsetData.error.message,
            code: adsetData.error.code,
            subcode: adsetData.error.error_subcode,
            user_title: adsetData.error.error_user_title || "",
            user_msg: adsetData.error.error_user_msg || "",
            raw: adsetData.error,
          },
        });
      } else {
        logs.push(`✅ SUCCESS: adset_id=${adsetData.id}`);
        createdAdsetIds.push(adsetData.id);
        results.push({
          attempt: attempt.name,
          promoted_object: attempt.promoted_object,
          full_payload: sanitized,
          success: true,
          adset_id: adsetData.id,
          meta_response: adsetData,
        });
      }
    }

    // ===== CLEANUP: Delete test adsets and campaign =====
    logs.push(`═══ CLEANUP ═══`);
    for (const adsetId of createdAdsetIds) {
      try {
        const delRes = await fetch(`https://graph.facebook.com/v22.0/${adsetId}?access_token=${access_token}`, { method: "DELETE" });
        const delData = await delRes.json();
        logs.push(`Deleted adset ${adsetId}: ${JSON.stringify(delData)}`);
      } catch (e) {
        logs.push(`Failed to delete adset ${adsetId}: ${e.message}`);
      }
    }
    try {
      const delRes = await fetch(`https://graph.facebook.com/v22.0/${campaignId}?access_token=${access_token}`, { method: "DELETE" });
      const delData = await delRes.json();
      logs.push(`Deleted campaign ${campaignId}: ${JSON.stringify(delData)}`);
    } catch (e) {
      logs.push(`Failed to delete campaign ${campaignId}: ${e.message}`);
    }

    // ===== SUMMARY =====
    logs.push(`═══ SUMMARY ═══`);
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    logs.push(`Total attempts: ${results.length}`);
    logs.push(`Successful: ${successful.length} — ${successful.map(r => r.attempt).join(", ") || "none"}`);
    logs.push(`Failed: ${failed.length} — ${failed.map(r => r.attempt).join(", ") || "none"}`);

    if (successful.length > 0) {
      logs.push(`✅ MINIMUM VALID promoted_object: ${JSON.stringify(successful[0].promoted_object)}`);
    } else {
      logs.push(`❌ NO valid promoted_object found. Check logs above for details.`);
    }
    logs.push(`Interpretation policy: no automatic account-link conclusion. Decide using raw response per attempt.`);

    // Print logs to edge function console for server-side visibility
    for (const l of logs) console.log(`[fase3-diag] ${l}`);

    return new Response(JSON.stringify({ ok: true, results, logs }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[fase3-diag] unhandled error", e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
