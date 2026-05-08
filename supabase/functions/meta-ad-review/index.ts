import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Diagnóstico de rejeição de ad: consulta ad_review_feedback + effective_status + creative bruto.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_id } = await req.json();
    if (!access_token || !ad_id) {
      return new Response(JSON.stringify({ error: "access_token e ad_id obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adFields = "id,name,status,effective_status,ad_review_feedback,issues_info,recommendations,creative{id,object_story_spec,source_instagram_media_id,instagram_user_id,effective_object_story_id,call_to_action_type,object_type,status},adset{id,name,promoted_object,destination_type,optimization_goal}";
    const adRes = await fetch(`https://graph.facebook.com/v25.0/${ad_id}?fields=${adFields}&access_token=${access_token}`);
    const adData = await adRes.json();

    return new Response(JSON.stringify(adData, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
