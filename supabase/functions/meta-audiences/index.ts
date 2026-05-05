import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id } = await req.json();

    const audiences: { id: string; name: string; type: "custom" | "saved"; targeting_spec?: any }[] = [];

    // Fetch custom audiences (paginated)
    let customUrl: string | null = `https://graph.facebook.com/v22.0/${ad_account_id}/customaudiences?fields=id,name&limit=200&access_token=${access_token}`;
    while (customUrl) {
      const res = await fetch(customUrl);
      const data = await res.json();
      if (data.data) {
        for (const a of data.data) {
          audiences.push({ id: a.id, name: a.name, type: "custom" });
        }
      }
      customUrl = data.paging?.next || null;
    }

    // Fetch saved audiences (paginated) with targeting
    let savedUrl: string | null = `https://graph.facebook.com/v22.0/${ad_account_id}/saved_audiences?fields=id,name,targeting&limit=200&access_token=${access_token}`;
    while (savedUrl) {
      const res = await fetch(savedUrl);
      const data = await res.json();
      if (data.data) {
        for (const a of data.data) {
          audiences.push({ id: a.id, name: a.name, type: "saved", targeting_spec: a.targeting || null });
        }
      }
      savedUrl = data.paging?.next || null;
    }

    return new Response(JSON.stringify({ audiences }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
