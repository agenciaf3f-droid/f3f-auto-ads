import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Cria custom audience baseada em VV50% de um video específico (FASE 2)
// Endpoint: POST /act_X/customaudiences

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id, video_id, name, retention_days = 365, percent = 50 } = await req.json();
    if (!access_token || !ad_account_id || !video_id) {
      return new Response(JSON.stringify({ error: "access_token, ad_account_id e video_id são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const audienceName = name || `VV${percent}% [video ${video_id.substring(0, 10)}]`;
    const retention_seconds = retention_days * 86400;
    const eventValue = `video_view_${percent}_percent`;

    const rule = {
      inclusions: {
        operator: "or",
        rules: [{
          event_sources: [{ id: video_id, type: "video" }],
          retention_seconds,
          filter: {
            operator: "and",
            filters: [{ field: "event", operator: "=", value: eventValue }],
          },
        }],
      },
    };

    const formData = new FormData();
    formData.append("access_token", access_token);
    formData.append("name", audienceName);
    formData.append("subtype", "ENGAGEMENT");
    formData.append("rule", JSON.stringify(rule));

    const res = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/customaudiences`, {
      method: "POST", body: formData,
    });
    const data = await res.json();
    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message, code: data.error.code, subcode: data.error.error_subcode }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ audience_id: data.id, name: audienceName }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
