import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mesmos campos de meta-campaign-insights (subset usado pelas métricas do registry).
const INSIGHTS_FIELDS = "spend,impressions,clicks,actions,video_p95_watched_actions";

// Rate-limit / transiente da Meta (mesmos códigos de meta-campaign-insights). Sem traduzir, o dialog
// fecharia mostrando "(#17) User request limit reached" cru; com tradução dá mensagem acionável.
const TRANSIENT_META_CODES = [1, 2, 4, 17, 32, 341, 613];
type MetaError = { code?: number; is_transient?: boolean; message?: string };
const isTransientMeta = (err?: MetaError | null): boolean =>
  !!err && (err.is_transient === true || TRANSIENT_META_CODES.includes(Number(err.code)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const metaErrorResponse = (err: MetaError) => {
  const message = isTransientMeta(err)
    ? "Limite de requisições da Meta atingido, tente novamente mais tarde."
    : (err?.message ?? "Erro desconhecido da Meta");
  return new Response(JSON.stringify({ error: message }), {
    status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
};

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
  adsetId?: string;
  dailyBudget?: string;
  lifetimeBudget?: string;
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
    // daily_budget/lifetime_budget só fazem sentido no nível adset (orçamento ABO vive no conjunto,
    // não no criativo) — alimenta o drill-in de orçamento do OptimizationBoard.
    const structureFields = level === "adset"
      ? "id,name,effective_status,daily_budget,lifetime_budget"
      : "id,name,effective_status,adset_id";
    const structureUrl = `https://graph.facebook.com/v25.0/${campaign_id}/${level}s?fields=${structureFields}&limit=200&access_token=${access_token}`;
    // A Graph NÃO devolve adset_id/ad_id na linha de insights só por causa do level= — o campo precisa
    // estar em fields, senão o join por row[idField] (abaixo) nunca casa e todo nó sai zerado (mesmo
    // motivo do campaign_id explícito em meta-client-insights).
    const idField = level === "adset" ? "adset_id" : "ad_id";
    const insightsFields = `${INSIGHTS_FIELDS},${idField}`;
    // limit=200 no insights TAMBÉM: o /insights?level=adset|ad pagina em ~25 por default. Sem isso,
    // campanha com >25 nós (FASE 2 = 1 criativo + N adsets) traz métrica só dos 25 primeiros e o
    // resto renderiza "sem dados" — gestor pausaria o nó errado.
    const insightsUrl = `https://graph.facebook.com/v25.0/${campaign_id}/insights?level=${level}&fields=${insightsFields}&${rangeParam}&limit=200&access_token=${access_token}`;

    // Retry com backoff em erro transiente/rate-limit da Meta (code 17/613/…). O drill-in dispara as
    // 2 chamadas Graph logo depois do board já ter queimado insights de todas as campanhas — pico que
    // pode tropeçar no code 17 e devolver 400 (a msg PT amigável é preservada no final). Só re-tenta em
    // erro transiente; erro real (campanha inválida, token) falha na hora.
    // Backoff CURTO (1s/3s, ~4s máx): o drill-in é interativo. Retry curto recupera blip momentâneo
    // (code 1/2); rate-limit sustentado (17) só limpa em minutos — não adianta esperar, falha rápido e
    // a msg PT ("aguarde ~15 min") orienta o usuário. Melhor UX que travar a tela por dezenas de seg.
    const RETRY_BACKOFF_MS = [1000, 3000];
    let structureData: { error?: MetaError; data?: unknown[] } = {};
    let insightsData: { error?: MetaError; data?: unknown[] } = {};
    for (let attempt = 0; ; attempt++) {
      const [structureRes, insightsRes] = await Promise.all([fetch(structureUrl), fetch(insightsUrl)]);
      [structureData, insightsData] = await Promise.all([structureRes.json(), insightsRes.json()]);
      const transientErr = [structureData.error, insightsData.error].find(isTransientMeta);
      if (transientErr && attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      break;
    }

    if (structureData.error) return metaErrorResponse(structureData.error);
    if (insightsData.error) return metaErrorResponse(insightsData.error);

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
        adsetId: n.adset_id as string | undefined,
        dailyBudget: n.daily_budget as string | undefined,
        lifetimeBudget: n.lifetime_budget as string | undefined,
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
