import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, node_id, field, value } = await req.json();
    if (!access_token || !node_id || (field !== "daily_budget" && field !== "lifetime_budget") || !Number.isFinite(value)) {
      return new Response(JSON.stringify({ error: "access_token, node_id, field (daily_budget|lifetime_budget) and numeric value required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // node_id serve pra campanha (CBO) OU adset (ABO) — POST /{id} é idêntico pros dois, igual
    // meta-campaign-pause. `value` já vem calculada pelo chamador na MESMA unidade que a Meta usa
    // (centavos) — essa edge só repassa, sem conversão.
    const url = `https://graph.facebook.com/v25.0/${node_id}?access_token=${access_token}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [field]: String(Math.round(value)) }),
    });
    const data = await res.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
