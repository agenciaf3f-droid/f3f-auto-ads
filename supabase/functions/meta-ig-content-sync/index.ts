// Edge function: sincroniza a tabela local `dash` com o conteúdo orgânico do Instagram de um
// cliente (posts/reels + engajamento), puxado sob demanda via Graph API v25.0 (botão
// "Sincronizar" na aba Dash). Os dados TÊM dono (user_id) → autentica o chamador via JWT
// (padrão sync-whatsapp-groups) e grava com service-role. Retry/backoff em erro transiente da
// Meta (padrão meta-node-insights). Teste rápido — 1 cliente, teto MAX_PAGES*PAGE_LIMIT posts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Rate-limit / transiente da Meta — mesmos códigos de meta-node-insights/meta-campaign-insights.
const TRANSIENT_META_CODES = [1, 2, 4, 17, 32, 341, 613];
type MetaError = { code?: number; is_transient?: boolean; message?: string };
const isTransientMeta = (err?: MetaError | null): boolean =>
  !!err && (err.is_transient === true || TRANSIENT_META_CODES.includes(Number(err.code)));
const RETRY_BACKOFF_MS = [1000, 3000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MEDIA_FIELDS = "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count";
const PAGE_LIMIT = 50;
const MAX_PAGES = 10;
const VIEWS_CONCURRENCY = 5;

// Métrica de views de Reel na Graph. v25.0: `plays` foi descontinuado em favor do `views`
// unificado (deprecação Meta ~abr/2025, a partir da v22.0). NÃO foi possível confirmar ao vivo
// nesta sessão (sem MCP oráculo Meta) — se o teste real mostrar views null + erro NÃO-transiente
// no log da function, o nome/forma da métrica é o que se ajusta aqui.
const VIEWS_METRIC = "views";

// Pool de workers com teto de concorrência (padrão meta-campaign-insights). fn muta o item in-place
// (grava views_count na própria row), então não precisa devolver nada.
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// Uma linha da tabela `dash`. student_name FICA DE FORA do tipo de propósito: o upsert só toca
// colunas presentes no payload, então omitir a chave (não mandar null) preserva a edição manual
// da tela numa resync seguinte.
interface DashRow {
  client_id: string;
  user_id: string;
  ig_media_id: string;
  media_type: string | null;
  media_product_type: string | null;
  posted_at: string | null;
  like_count: number | null;
  comments_count: number | null;
  views_count: number | null;
  caption: string | null;
  permalink: string | null;
  synced_at: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Não autenticado" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Valida o chamador via JWT (client anon escopado pelo header), grava com service-role.
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      console.log("[meta-ig-content-sync] Auth error:", authError?.message);
      return json({ error: "Sessão inválida" }, 401);
    }

    const body = await req.json();
    const { client_id, ig_account_id } = body as {
      client_id?: string;
      ig_account_id?: string;
    };
    if (!client_id || !ig_account_id) {
      return json({ error: "client_id e ig_account_id são obrigatórios" }, 400);
    }

    // App Meta SEPARADO, só pra este sync — já com BM verificada e instagram_manage_insights
    // aprovado (o app principal do sistema não tem essa permissão; pedir revisão só pra isso
    // travaria o resto do publish). ig_account_id ainda é resolvido pelo front via a conexão
    // principal (precisa ads_management/pages_show_list, que só ela tem) — só a leitura de
    // mídia/insights do Instagram em si usa este token à parte.
    const access_token = Deno.env.get("DASH_META_ACCESS_TOKEN");
    if (!access_token) {
      return json({ error: "DASH_META_ACCESS_TOKEN não configurado" }, 500);
    }

    // 1. Posts/reels paginados (teto MAX_PAGES). views_count NÃO entra em MEDIA_FIELDS de propósito:
    // é métrica de insights, não campo do nó — um campo inválido em fields= derruba a /media inteira
    // (erro 100), virando "1 reel sem views" em "sync morto". Views vêm num passo isolado abaixo.
    const rows: DashRow[] = [];
    let url: string | null =
      `https://graph.facebook.com/v25.0/${ig_account_id}/media?fields=${MEDIA_FIELDS}&limit=${PAGE_LIMIT}&access_token=${access_token}`;
    let page = 0;
    while (url && page < MAX_PAGES) {
      let data: any = {};
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url);
        data = await res.json();
        if (data.error && isTransientMeta(data.error) && attempt < RETRY_BACKOFF_MS.length) {
          await sleep(RETRY_BACKOFF_MS[attempt]);
          continue;
        }
        break;
      }
      if (data.error) {
        const msg = isTransientMeta(data.error)
          ? "Limite de requisições da Meta atingido, tente novamente mais tarde."
          : data.error.message;
        return json({ error: msg }, 400);
      }
      for (const m of (data.data || []) as any[]) {
        rows.push({
          client_id,
          user_id: user.id, // sem isso a policy SELECT (auth.uid()=user_id) do front nunca acha a linha
          ig_media_id: m.id,
          media_type: m.media_type ?? null,
          media_product_type: m.media_product_type ?? null,
          posted_at: m.timestamp ?? null,
          like_count: m.like_count ?? null,
          comments_count: m.comments_count ?? null,
          views_count: null, // preenchido no passo de views abaixo (só reels), se disponível
          caption: m.caption ?? null,
          permalink: m.permalink ?? null,
          synced_at: new Date().toISOString(),
        });
      }
      url = data.paging?.next || null;
      page++;
    }

    // 1b. Perfil (teste): dado de CONTA, não de post — só possível com o token do app separado
    // (instagram_manage_insights). Campos básicos (`?fields=...`) + insights de conta
    // (`/insights?metric=...&period=day`, soma últimos 7 dias) — os últimos são exatamente o que
    // o app principal NÃO consegue puxar hoje. Falha aqui não aborta o sync de posts (best-effort,
    // profile fica null se der erro — mesmo espírito de "não derruba o resto" do passo de views).
    let profile: Record<string, unknown> | null = null;
    try {
      const profileFieldsUrl =
        `https://graph.facebook.com/v25.0/${ig_account_id}?fields=username,name,biography,followers_count,follows_count,media_count,profile_picture_url&access_token=${access_token}`;
      const profileRes = await fetch(profileFieldsUrl);
      const profileData = await profileRes.json();
      if (profileData.error) {
        console.log("[meta-ig-content-sync] Profile fields error:", profileData.error?.code, profileData.error?.message);
      } else {
        profile = { ...profileData };
      }

      // Métricas de conta exigem instagram_manage_insights — nome/período não confirmados ao vivo
      // nesta sessão (mesma ressalva do VIEWS_METRIC acima). reach/profile_views são os nomes mais
      // estáveis historicamente pra período diário de conta profissional.
      const since = Math.floor(Date.now() / 1000) - 7 * 86400;
      const until = Math.floor(Date.now() / 1000);
      const insightsUrl =
        `https://graph.facebook.com/v25.0/${ig_account_id}/insights?metric=reach,profile_views,accounts_engaged&period=day&since=${since}&until=${until}&access_token=${access_token}`;
      const acctInsightsRes = await fetch(insightsUrl);
      const acctInsightsData = await acctInsightsRes.json();
      if (acctInsightsData.error) {
        console.log("[meta-ig-content-sync] Account insights error:", acctInsightsData.error?.code, acctInsightsData.error?.message);
      } else {
        const sums: Record<string, number> = {};
        for (const m of (acctInsightsData.data || []) as any[]) {
          const total = (m.values || []).reduce((s: number, v: any) => s + (typeof v.value === "number" ? v.value : 0), 0);
          sums[m.name] = total;
        }
        profile = { ...(profile || {}), insights_7d: sums };
      }
    } catch (e) {
      console.log("[meta-ig-content-sync] Profile fetch failed:", (e as Error).message);
    }

    // 2. Views (só reels): 1 chamada de insights por reel. Erro TRANSIENTE aqui NÃO aborta o sync —
    // os posts são salvos com views_count null e o retorno sinaliza views_rate_limited + views_warning
    // pro front avisar o gestor (pedido explícito do usuário: não pode ser silencioso).
    let viewsRateLimited = false;
    let viewsWarning: string | null = null;
    const reelRows = rows.filter((r) => r.media_product_type === "REELS");
    await mapWithConcurrency(reelRows, VIEWS_CONCURRENCY, async (row) => {
      const insightsUrl =
        `https://graph.facebook.com/v25.0/${row.ig_media_id}/insights?metric=${VIEWS_METRIC}&access_token=${access_token}`;
      let vData: any = {};
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(insightsUrl);
        vData = await res.json();
        if (vData.error && isTransientMeta(vData.error) && attempt < RETRY_BACKOFF_MS.length) {
          await sleep(RETRY_BACKOFF_MS[attempt]);
          continue;
        }
        break;
      }
      if (vData.error) {
        // Loga code+message (sem a URL, pro token não vazar). Sem isso, views null vira
        // indistinguível entre métrica errada, scope ausente (instagram_manage_insights) e zero
        // real — e a verificação do nome da métrica só rola no 1º run real (sem oráculo offline).
        console.log("[meta-ig-content-sync] Views insight error:", vData.error?.code, vData.error?.message);
        if (isTransientMeta(vData.error)) {
          viewsRateLimited = true;
          viewsWarning = "Limite de requisições da Meta atingido ao buscar views — alguns reels ficaram sem esse número.";
        }
        // erro não-transiente (ex: permissão, métrica ausente) em UM item não derruba o resto —
        // só esse reel fica com views_count null.
        return;
      }
      const metric = (vData.data as any[] | undefined)?.find((d) => d.name === VIEWS_METRIC);
      // dupla forma de resposta: métrica lifetime clássica (values[]) ou a nova total_value.
      const viewsValue = metric?.values?.[0]?.value ?? metric?.total_value?.value;
      if (typeof viewsValue === "number") row.views_count = viewsValue;
    });

    // 3. Upsert (service-role, ignora RLS). onConflict casa a UNIQUE(client_id, ig_media_id):
    // resync não duplica e, como student_name não está no payload, edição manual sobrevive.
    const dbClient = createClient(supabaseUrl, serviceRoleKey);
    if (rows.length > 0) {
      const { error: upsertError } = await dbClient
        .from("dash")
        .upsert(rows, { onConflict: "client_id,ig_media_id" });
      if (upsertError) {
        console.error("[meta-ig-content-sync] Upsert falhou:", upsertError.message);
        return json({ error: "Falha ao gravar conteúdo sincronizado" }, 500);
      }
    }

    return json({ ok: true, synced: rows.length, views_rate_limited: viewsRateLimited, views_warning: viewsWarning, profile });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[meta-ig-content-sync] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
