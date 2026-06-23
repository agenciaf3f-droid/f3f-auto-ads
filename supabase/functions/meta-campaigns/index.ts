import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id } = await req.json();
    if (!access_token || !ad_account_id) {
      return new Response(JSON.stringify({ error: "access_token and ad_account_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // effective_status filter=ACTIVE: só campanhas ativas no dropdown.
    // daily_budget/lifetime_budget: frontend detecta CBO (tem budget) vs ABO (sem).
    const filtering = encodeURIComponent(JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]));
    const url = `https://graph.facebook.com/v25.0/${ad_account_id}/campaigns?fields=id,name,status,effective_status,objective,created_time,daily_budget,lifetime_budget,bid_strategy&filtering=${filtering}&limit=200&access_token=${access_token}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ campaigns: data.data || [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
