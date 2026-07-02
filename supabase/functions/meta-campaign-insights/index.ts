import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Códigos transientes/rate-limit da Meta — mesmo critério de meta-publish/index.ts:43.
const TRANSIENT_META_CODES = [1, 2, 4, 17, 32, 341, 613];
const isTransientMeta = (err: any) =>
  !!err && (err.is_transient === true || TRANSIENT_META_CODES.includes(Number(err?.code)));

const INSIGHTS_FIELDS = "spend,cpm,ctr,cpc,cpp,actions,cost_per_action_type,frequency";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, campaign_ids } = await req.json();
    if (!access_token || !Array.isArray(campaign_ids) || campaign_ids.length === 0) {
      return new Response(JSON.stringify({ error: "access_token and campaign_ids required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const insights: Record<string, unknown> = {};
    for (const campaignId of campaign_ids) {
      const url = `https://graph.facebook.com/v25.0/${campaignId}/insights?fields=${INSIGHTS_FIELDS}&date_preset=last_7d&access_token=${access_token}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        if (isTransientMeta(data.error)) {
          return new Response(JSON.stringify({ error: "Limite de requisições da Meta atingido, aguarde ~15 min e tente novamente.", rate_limited: true }), {
            status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        insights[campaignId] = { error: data.error.message };
        continue;
      }

      // Campanha sem veiculação suficiente ainda retorna data vazio — sem violação avaliável.
      insights[campaignId] = data.data?.[0] || null;
    }

    return new Response(JSON.stringify({ insights }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
