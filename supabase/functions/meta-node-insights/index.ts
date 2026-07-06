import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mesmos campos de meta-campaign-insights (subset usado pelas métricas do registry).
const INSIGHTS_FIELDS = "spend,impressions,clicks,actions,video_p95_watched_actions";

type Level = "adset" | "ad";

type ActionValue = { action_type: string; value: string };

type NodeOut = {
  id: string;
  name: string;
  effective_status: string;
  spend: number;
  impressions: number;
  clicks: number;
  actionCounts: Record<string, number>;
  vv95: number;
};

const num = (v?: string | number): number => {
  const n = typeof v === "number" ? v : parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { access_token, campaign_id, level, date_preset, since, until } = body as {
      access_token?: string;
      campaign_id?: string;
      level?: Level;
      date_preset?: string;
      since?: string;
      until?: string;
    };

    if (!access_token || !campaign_id || (level !== "adset" && level !== "ad")) {
      return new Response(JSON.stringify({ error: "access_token, campaign_id and level (adset|ad) required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Range: time_range (custom) tem prioridade sobre date_preset. Default last_7d — mesmo
    // padrão de meta-campaign-insights/meta-client-insights.
    const rangeParam = since && until
      ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
      : `date_preset=${encodeURIComponent(date_preset || "last_7d")}`;

    // Estrutura (lista de nós) e insights nativamente agregados por nó (level=adset/ad já
    // devolve uma linha por adset_id/ad_id, sem precisar de 1 chamada por nó).
    const structureFields = level === "adset" ? "id,name,effective_status" : "id,name,effective_status,adset_id";
    const structureUrl = `https://graph.facebook.com/v25.0/${campaign_id}/${level}s?fields=${structureFields}&limit=200&access_token=${access_token}`;
    const insightsUrl = `https://graph.facebook.com/v25.0/${campaign_id}/insights?level=${level}&fields=${INSIGHTS_FIELDS}&${rangeParam}&access_token=${access_token}`;

    const [structureRes, insightsRes] = await Promise.all([fetch(structureUrl), fetch(insightsUrl)]);
    const [structureData, insightsData] = await Promise.all([structureRes.json(), insightsRes.json()]);

    if (structureData.error) {
      return new Response(JSON.stringify({ error: structureData.error.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (insightsData.error) {
      return new Response(JSON.stringify({ error: insightsData.error.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const idField = level === "adset" ? "adset_id" : "ad_id";
    const insightsByNodeId = new Map<string, Record<string, unknown>>();
    for (const row of (insightsData.data || []) as Record<string, unknown>[]) {
      const id = row[idField] as string | undefined;
      if (id) insightsByNodeId.set(id, row);
    }

    const nodes: NodeOut[] = ((structureData.data || []) as Record<string, unknown>[]).map((n) => {
      const insight = insightsByNodeId.get(n.id as string);
      const actionCounts: Record<string, number> = {};
      let vv95 = 0;
      if (insight) {
        for (const a of (insight.actions as ActionValue[] | undefined) || []) {
          actionCounts[a.action_type] = (actionCounts[a.action_type] || 0) + num(a.value);
        }
        for (const v of (insight.video_p95_watched_actions as ActionValue[] | undefined) || []) {
          vv95 += num(v.value);
        }
      }
      return {
        id: n.id as string,
        name: n.name as string,
        effective_status: n.effective_status as string,
        spend: insight ? num(insight.spend as string) : 0,
        impressions: insight ? num(insight.impressions as string) : 0,
        clicks: insight ? num(insight.clicks as string) : 0,
        actionCounts,
        vv95,
      };
    });

    return new Response(JSON.stringify({ nodes }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
