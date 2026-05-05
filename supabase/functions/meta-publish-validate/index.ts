import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatMetaError(err: any): string {
  if (!err) return "Erro desconhecido";
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  if (err.error_user_title) parts.push(`[${err.error_user_title}]`);
  if (err.error_user_msg) parts.push(err.error_user_msg);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.error_subcode) parts.push(`subcode=${err.error_subcode}`);
  return parts.join(" | ") || "Erro desconhecido";
}

function extractFullError(err: any) {
  return {
    message: err?.message || "",
    error_user_title: err?.error_user_title || "",
    error_user_msg: err?.error_user_msg || "",
    code: err?.code || null,
    error_subcode: err?.error_subcode || null,
    error_data: err?.error_data || null,
  };
}

function buildTargeting(audienceType: string, audienceId: string, targetingSpec: any) {
  if (audienceType === "saved" && targetingSpec) {
    const clean = { ...targetingSpec };
    delete clean.targeting_optimization;
    delete clean.brand_safety_content_filter_levels;
    return clean;
  }
  return {
    custom_audiences: [{ id: audienceId }],
    geo_locations: { countries: ["BR"] },
  };
}

async function tryCreateAdset(
  adAccountId: string,
  campaignId: string,
  budgetCents: number,
  targeting: any,
  accessToken: string
): Promise<{ ok: boolean; adsetId?: string; error?: any }> {
  const res = await fetch(`https://graph.facebook.com/v22.0/${adAccountId}/adsets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `__validate_adset_${Date.now()}`,
      campaign_id: campaignId,
      daily_budget: budgetCents,
      billing_event: "IMPRESSIONS",
      optimization_goal: "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting,
      status: "PAUSED",
      start_time: new Date(Date.now() + 86400000).toISOString(),
      access_token: accessToken,
    }),
  });
  const data = await res.json();
  if (data.error) return { ok: false, error: data.error };
  return { ok: true, adsetId: data.id };
}

async function cleanup(ids: string[], accessToken: string) {
  await Promise.all(
    ids.map(id =>
      fetch(`https://graph.facebook.com/v22.0/${id}?access_token=${accessToken}`, { method: "DELETE" }).catch(() => {})
    )
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t0 = Date.now();
  const timings: { step: string; ms: number; source: string }[] = [];
  function mark(step: string, start: number, source = "api") {
    const ms = Date.now() - start;
    timings.push({ step, ms, source });
    console.log(`[validate] ${step}: ${ms}ms (${source})`);
  }

  try {
    const body = await req.json();
    const { access_token, ad_account_id, audience_id, audience_type, targeting_spec, budget, generated_name, skip_token_check } = body;

    const checks: { label: string; ok: boolean; detail: string }[] = [];
    checks.push({ label: "Access Token", ok: !!access_token, detail: access_token ? "presente" : "ausente" });
    checks.push({ label: "Conta de Anúncios", ok: !!ad_account_id, detail: ad_account_id || "ausente" });
    checks.push({ label: "Público", ok: !!audience_id, detail: `${audience_id} (${audience_type || "unknown"})` });
    checks.push({ label: "Orçamento", ok: Number(budget) > 0, detail: budget ? `R$${budget}` : "ausente" });
    checks.push({ label: "Nome Gerado", ok: !!generated_name, detail: generated_name || "ausente" });
    mark("field_checks", t0, "local");

    if (!checks.every((c) => c.ok)) {
      return new Response(JSON.stringify({ valid: false, checks, timings }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify token (skip if frontend already confirmed recently)
    if (!skip_token_check) {
      const tToken = Date.now();
      const tokenCheck = await fetch(`https://graph.facebook.com/v22.0/me?access_token=${access_token}`);
      const tokenData = await tokenCheck.json();
      mark("token_verify", tToken);
      if (tokenData.error) {
        checks.push({ label: "Token Válido", ok: false, detail: tokenData.error.message });
        return new Response(JSON.stringify({ valid: false, checks, error: formatMetaError(tokenData.error), error_details: extractFullError(tokenData.error), timings }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      checks.push({ label: "Token Válido", ok: true, detail: "OK" });
    } else {
      checks.push({ label: "Token Válido", ok: true, detail: "pulado (cache)" });
      mark("token_verify", t0, "skipped");
    }

    // Build targeting
    const targeting = buildTargeting(audience_type || "custom", audience_id, targeting_spec);
    checks.push({ label: "Tipo Público", ok: true, detail: audience_type || "custom" });

    // Create a PAUSED campaign
    const tCampaign = Date.now();
    const campaignRes = await fetch(`https://graph.facebook.com/v22.0/${ad_account_id}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `__validate_${Date.now()}`,
        objective: "OUTCOME_TRAFFIC",
        status: "PAUSED",
        buying_type: "AUCTION",
        special_ad_categories: [],
        is_adset_budget_sharing_enabled: false,
        access_token,
      }),
    });
    const campaignData = await campaignRes.json();
    mark("create_test_campaign", tCampaign);

    if (campaignData.error) {
      return new Response(JSON.stringify({
        valid: false, checks,
        error: formatMetaError(campaignData.error),
        error_details: extractFullError(campaignData.error),
        timings,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const testCampaignId = campaignData.id;
    const budgetCents = Math.round(Number(budget) * 100);

    // Try creating AdSet with user's budget
    const tAdset = Date.now();
    const adsetResult = await tryCreateAdset(ad_account_id, testCampaignId, budgetCents, targeting, access_token);
    mark("create_test_adset", tAdset);

    if (adsetResult.ok) {
      const tClean = Date.now();
      const cleanupIds = [testCampaignId];
      if (adsetResult.adsetId) cleanupIds.unshift(adsetResult.adsetId);
      await cleanup(cleanupIds, access_token);
      mark("cleanup_success", tClean);
      mark("TOTAL", t0);

      return new Response(JSON.stringify({ valid: true, checks, timings }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // AdSet failed - check if it's a budget error
    const adsetError = adsetResult.error;
    const isBudgetError = adsetError?.message?.toLowerCase().includes("budget") ||
                          adsetError?.error_subcode === 1487851 ||
                          adsetError?.code === 100;

    let minBudgetReal: number | null = null;

    if (isBudgetError) {
      const errMsg = adsetError.message || "";
      const minMatch = errMsg.match(/minimum.*?(\d[\d,.]+)/i) || errMsg.match(/at least.*?(\d[\d,.]+)/i);
      if (minMatch) {
        minBudgetReal = parseFloat(minMatch[1].replace(",", ".")) / 100;
        console.log(`[validate] min_budget extracted from error message: R$${minBudgetReal}`);
      }

      // NOTE: Binary search removed — too slow (up to 17 API calls). 
      // The error message extraction above handles most cases.
      // If it can't extract, we return the raw error to the user.
    }

    const tClean2 = Date.now();
    await cleanup([testCampaignId], access_token);
    mark("cleanup_failure", tClean2);
    mark("TOTAL", t0);

    return new Response(JSON.stringify({
      valid: false, checks,
      error: formatMetaError(adsetError),
      error_details: extractFullError(adsetError),
      min_budget: minBudgetReal,
      timings,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    mark("TOTAL_ERROR", t0);
    return new Response(JSON.stringify({ error: e.message, timings }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
