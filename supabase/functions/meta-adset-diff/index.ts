import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const API = "v22.0";

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
  "instagram_actor_id","issues_info",
  "learning_stage_info","lifetime_min_spend_target","lifetime_spend_cap",
  "daily_min_spend_target","daily_spend_cap",
  "existing_customer_budget_percentage",
  "multi_optimization_goal_weight","tune_for_category",
  "recurring_budget_semantics","review_feedback",
].join(",");

// Deep diff between two objects
function deepDiff(real: any, app: any, path = ""): { field: string; real_value: any; app_value: any }[] {
  const diffs: { field: string; real_value: any; app_value: any }[] = [];
  const allKeys = new Set([...Object.keys(real || {}), ...Object.keys(app || {})]);

  for (const key of allKeys) {
    const fullPath = path ? `${path}.${key}` : key;
    const rv = real?.[key];
    const av = app?.[key];

    // Skip volatile fields
    if (["id","name","campaign_id","created_time","updated_time","start_time","end_time",
         "daily_budget","lifetime_budget","budget_remaining","access_token",
         "daily_min_spend_target","daily_spend_cap","lifetime_min_spend_target","lifetime_spend_cap",
         "learning_stage_info","issues_info","review_feedback","effective_status","configured_status",
         "status"].includes(key) && !path) continue;

    if (rv === undefined && av === undefined) continue;
    if (rv === undefined) {
      diffs.push({ field: fullPath, real_value: "⛔ ABSENT", app_value: av });
    } else if (av === undefined) {
      diffs.push({ field: fullPath, real_value: rv, app_value: "⛔ ABSENT" });
    } else if (typeof rv === "object" && rv !== null && typeof av === "object" && av !== null) {
      if (Array.isArray(rv) || Array.isArray(av)) {
        if (JSON.stringify(rv) !== JSON.stringify(av)) {
          diffs.push({ field: fullPath, real_value: rv, app_value: av });
        }
      } else {
        diffs.push(...deepDiff(rv, av, fullPath));
      }
    } else if (String(rv) !== String(av)) {
      diffs.push({ field: fullPath, real_value: rv, app_value: av });
    }
  }
  return diffs;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id, app_adset_payload } = await req.json();
    if (!access_token || !ad_account_id) {
      return new Response(JSON.stringify({ ok: false, error: "access_token and ad_account_id required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const logs: string[] = [];
    logs.push("═══ ADSET DIFF DIAGNOSTIC ═══");

    // 1. Find real working WhatsApp adsets
    logs.push("Step 1: Searching for real WhatsApp adsets (ACTIVE or PAUSED)...");
    const url = `https://graph.facebook.com/${API}/${ad_account_id}/adsets?fields=${ADSET_FIELDS}&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]},{"field":"destination_type","operator":"EQUAL","value":"WHATSAPP"}]&limit=25&access_token=${access_token}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      logs.push(`❌ API error: ${JSON.stringify(data.error)}`);
      return new Response(JSON.stringify({ ok: false, error: data.error, logs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const realAdsets = data.data || [];
    logs.push(`Found ${realAdsets.length} WhatsApp adset(s)`);

    if (realAdsets.length === 0) {
      // Fallback: search ALL adsets regardless of destination
      logs.push("No WhatsApp adsets found. Searching ALL adsets with CONVERSATIONS goal...");
      const fallbackUrl = `https://graph.facebook.com/${API}/${ad_account_id}/adsets?fields=${ADSET_FIELDS}&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]&limit=50&access_token=${access_token}`;
      const fbRes = await fetch(fallbackUrl);
      const fbData = await fbRes.json();
      const convAdsets = (fbData.data || []).filter((a: any) =>
        a.optimization_goal === "CONVERSATIONS" || a.destination_type === "WHATSAPP"
      );
      if (convAdsets.length > 0) {
        realAdsets.push(...convAdsets);
        logs.push(`Fallback found ${convAdsets.length} adset(s) with CONVERSATIONS/WHATSAPP`);
      }
    }

    if (realAdsets.length === 0) {
      logs.push("❌ No reference adset found. Cannot diff.");
      return new Response(JSON.stringify({ ok: false, error: "No WhatsApp/CONVERSATIONS adset found", logs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Pick the best reference (prefer ACTIVE, then most recent)
    const reference = realAdsets.sort((a: any, b: any) => {
      if (a.effective_status === "ACTIVE" && b.effective_status !== "ACTIVE") return -1;
      if (b.effective_status === "ACTIVE" && a.effective_status !== "ACTIVE") return 1;
      return 0;
    })[0];

    logs.push(`Reference adset: id=${reference.id}, name="${reference.name}", status=${reference.effective_status}`);
    logs.push(`Reference promoted_object: ${JSON.stringify(reference.promoted_object)}`);
    logs.push(`Reference optimization_goal: ${reference.optimization_goal}`);
    logs.push(`Reference destination_type: ${reference.destination_type}`);
    logs.push(`Reference billing_event: ${reference.billing_event}`);
    logs.push(`Reference bid_strategy: ${reference.bid_strategy}`);

    // 3. Log WhatsApp-specific fields from reference
    const waFields: string[] = [];
    for (const key of Object.keys(reference)) {
      if (key.toLowerCase().includes("whatsapp") || key.toLowerCase().includes("messaging") ||
          key.toLowerCase().includes("conversation") || key === "promoted_object" ||
          key === "destination_type" || key === "attribution_spec") {
        waFields.push(key);
        logs.push(`Reference WA field [${key}]: ${JSON.stringify(reference[key])}`);
      }
    }

    // 4. Diff
    if (app_adset_payload) {
      logs.push("═══ DIFF: Real vs App ═══");

      // Clean app payload for comparison
      const appClean = { ...app_adset_payload };
      delete appClean.access_token;
      delete appClean.name;
      delete appClean.campaign_id;
      delete appClean.daily_budget;
      delete appClean.start_time;
      delete appClean.end_time;
      delete appClean.status;

      const diffs = deepDiff(reference, appClean);

      if (diffs.length === 0) {
        logs.push("✅ No structural differences found (excluding volatile fields)");
      } else {
        logs.push(`Found ${diffs.length} difference(s):`);
        for (const d of diffs) {
          logs.push(`  🔸 ${d.field}`);
          logs.push(`     REAL: ${JSON.stringify(d.real_value)}`);
          logs.push(`      APP: ${JSON.stringify(d.app_value)}`);
        }
      }

      // 5. WhatsApp number format analysis
      logs.push("═══ WHATSAPP NUMBER FORMAT ANALYSIS ═══");
      const realWaPhone = reference.promoted_object?.whatsapp_phone_number;
      const appWaPhone = appClean.promoted_object?.whatsapp_phone_number;
      logs.push(`Real whatsapp_phone_number: "${realWaPhone}" (type=${typeof realWaPhone}, len=${String(realWaPhone || "").length})`);
      logs.push(`App  whatsapp_phone_number: "${appWaPhone}" (type=${typeof appWaPhone}, len=${String(appWaPhone || "").length})`);

      if (realWaPhone && appWaPhone) {
        if (String(realWaPhone) === String(appWaPhone)) {
          logs.push("✅ whatsapp_phone_number values MATCH");
        } else {
          logs.push("❌ whatsapp_phone_number values DIFFER — this is likely the root cause");
          const realIsNumeric = /^\d+$/.test(String(realWaPhone));
          const appIsNumeric = /^\d+$/.test(String(appWaPhone));
          logs.push(`  Real format: ${realIsNumeric ? "pure numeric (internal ID)" : "mixed/phone format"}`);
          logs.push(`  App format:  ${appIsNumeric ? "pure numeric (internal ID)" : "mixed/phone format"}`);
        }
      }

      return new Response(JSON.stringify({
        ok: true,
        reference_adset: reference,
        app_payload: appClean,
        diffs,
        whatsapp_analysis: {
          real_phone: realWaPhone,
          app_phone: appWaPhone,
          match: String(realWaPhone) === String(appWaPhone),
        },
        logs,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // No app payload — just return reference
    return new Response(JSON.stringify({
      ok: true,
      reference_adset: reference,
      all_whatsapp_adsets: realAdsets,
      logs,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("[adset-diff] error:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
