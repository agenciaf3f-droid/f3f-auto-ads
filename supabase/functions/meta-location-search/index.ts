import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, query, type } = await req.json();
    if (!access_token || !query) {
      return new Response(JSON.stringify({ error: "access_token and query required", locations: [] }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use Meta's targeting search for geo locations
    const searchType = type || "adgeolocation";
    const url = `https://graph.facebook.com/v22.0/search?type=${searchType}&q=${encodeURIComponent(query)}&access_token=${access_token}`;
    
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message, locations: [] }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const locations = (data.data || []).map((loc: any) => ({
      key: loc.key,
      name: loc.name,
      type: loc.type,
      country_code: loc.country_code,
      country_name: loc.country_name,
      region: loc.region,
      supports_region: loc.supports_region,
      supports_city: loc.supports_city,
      display: loc.type === "country"
        ? loc.name
        : `${loc.name}${loc.region ? `, ${loc.region}` : ""}${loc.country_name ? ` — ${loc.country_name}` : ""}`,
    }));

    return new Response(JSON.stringify({ locations }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, locations: [] }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
