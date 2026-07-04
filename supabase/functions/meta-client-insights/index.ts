import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const timedFetch = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });

// Insights por conta de anúncio, nível campaign. Cada linha carrega o ad_account_id
// de origem (a Graph API não devolve isso no nível campaign) — o frontend precisa disso
// para agregar/avaliar KPI por conta, nunca cruzando contas diferentes.
const INSIGHT_FIELDS =
  "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpm,frequency,reach,actions,cost_per_action_type,video_p95_watched_actions";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { access_token, ad_account_ids, date_preset, since, until } = body as {
      access_token?: string;
      ad_account_ids?: string[];
      date_preset?: string;
      since?: string;
      until?: string;
    };

    if (!access_token || !Array.isArray(ad_account_ids) || ad_account_ids.length === 0) {
      return new Response(
        JSON.stringify({ error: "access_token e ad_account_ids[] são obrigatórios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Range: time_range (custom) tem prioridade sobre date_preset. Default last_30d.
    const rangeParam = since && until
      ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
      : `date_preset=${encodeURIComponent(date_preset || "last_30d")}`;

    const insights: Record<string, unknown>[] = [];
    const errors: { ad_account_id: string; message: string }[] = [];

    // Uma conta com erro não derruba as outras (Promise.all sobre tarefas que capturam).
    await Promise.all(
      ad_account_ids.map(async (adAccountId) => {
        try {
          let url: string | null =
            `https://graph.facebook.com/v25.0/${adAccountId}/insights` +
            `?level=campaign&fields=${INSIGHT_FIELDS}&${rangeParam}` +
            `&limit=500&access_token=${access_token}`;
          let guard = 0;
          while (url && guard < 20) {
            const res = await timedFetch(url);
            const data = await res.json();
            if (data.error) {
              errors.push({ ad_account_id: adAccountId, message: data.error.message });
              return;
            }
            for (const row of data.data || []) {
              insights.push({ ...row, ad_account_id: adAccountId });
            }
            url = data.paging?.next || null;
            guard++;
          }
        } catch (e) {
          errors.push({ ad_account_id: adAccountId, message: (e as Error).message });
        }
      }),
    );

    return new Response(
      JSON.stringify({ insights, errors: errors.length ? errors : undefined }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
