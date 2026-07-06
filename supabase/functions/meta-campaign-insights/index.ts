import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Códigos transientes/rate-limit da Meta — mesmo critério de meta-publish/index.ts:43.
const TRANSIENT_META_CODES = [1, 2, 4, 17, 32, 341, 613];
const isTransientMeta = (err: any) =>
  !!err && (err.is_transient === true || TRANSIENT_META_CODES.includes(Number(err?.code)));

const INSIGHTS_FIELDS = "spend,impressions,clicks,cpm,ctr,cpc,cpp,actions,cost_per_action_type,frequency,video_p95_watched_actions";

// Cap de concorrência dos fetches à Graph API dentro de UMA invocação. Antes era serial (1 por vez);
// paralelizar com teto evita disparar rate-limit da Meta (Promise.all sem limite dispararia tudo de vez).
const INSIGHTS_CONCURRENCY = 6;

// Pool de workers: roda `fn` sobre `items` com no máx `limit` execuções simultâneas, preservando a
// posição de cada resultado no array de saída. Se `fn` lançar, o erro propaga (mantém o 500 do handler).
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { access_token, campaign_ids, date_preset, since, until } = body as {
      access_token?: string;
      campaign_ids?: string[];
      date_preset?: string;
      since?: string;
      until?: string;
    };
    if (!access_token || !Array.isArray(campaign_ids) || campaign_ids.length === 0) {
      return new Response(JSON.stringify({ error: "access_token and campaign_ids required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Range: time_range (custom) tem prioridade sobre date_preset. Default last_7d (comportamento
    // pré-existente, preservado quando nenhum range é enviado — ver meta-client-insights p/ o mesmo padrão).
    const rangeParam = since && until
      ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
      : `date_preset=${encodeURIComponent(date_preset || "last_7d")}`;

    // Uma chamada à Graph API por campanha, em paralelo com teto de concorrência. O tratamento
    // por campanha é idêntico ao serial anterior: transiente vira { error: "Limite..." }, outro
    // erro vira { error: message }, sem dados vira null — e sempre só afeta aquela campanha.
    async function fetchInsight(campaignId: string): Promise<unknown> {
      const url = `https://graph.facebook.com/v25.0/${campaignId}/insights?fields=${INSIGHTS_FIELDS}&${rangeParam}&access_token=${access_token}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        if (isTransientMeta(data.error)) {
          // Erro transiente/rate-limit só nessa campanha — pula ela e mantém os insights já
          // coletados das outras nesta mesma requisição, em vez de descartar o lote inteiro.
          console.error(`meta-campaign-insights: erro transiente da Meta pra campanha ${campaignId}, pulando`, data.error);
          return { error: "Limite de requisições da Meta atingido, tente novamente mais tarde." };
        }
        return { error: data.error.message };
      }

      // Campanha sem veiculação suficiente ainda retorna data vazio — sem violação avaliável.
      return data.data?.[0] || null;
    }

    const results = await mapWithConcurrency(campaign_ids, INSIGHTS_CONCURRENCY, fetchInsight);
    const insights: Record<string, unknown> = {};
    campaign_ids.forEach((campaignId, i) => { insights[campaignId] = results[i]; });

    return new Response(JSON.stringify({ insights }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
