import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cacheDiscovery } from "../_shared/discovery-cache.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Lista pixels (Meta Ads Pixel) acessíveis à conta de anúncios.
// Endpoint: GET /act_<id>/adspixels?fields=id,name,is_unavailable,creation_time

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id } = await req.json();
    if (!access_token || !ad_account_id) {
      return new Response(JSON.stringify({ error: "access_token e ad_account_id são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = `https://graph.facebook.com/v25.0/${ad_account_id}/adspixels?fields=id,name,is_unavailable,creation_time&limit=200&access_token=${access_token}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pixels = (data.data || [])
      .filter((p: any) => !p.is_unavailable)
      .map((p: any) => ({ id: p.id, name: p.name || p.id, creation_time: p.creation_time }));

    await cacheDiscovery("pixels", ad_account_id, pixels);

    return new Response(JSON.stringify({ pixels }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
