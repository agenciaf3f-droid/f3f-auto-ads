// Edge function: sincroniza a tabela local whatsapp_groups a partir das 2 fontes na base
// Agenciaf3f (client_dashboards + log de mensagens "Controle de Mensagens"). Roda sob demanda
// (botão "Sincronizar" no ClientForm), não a cada abertura do form — client_dashboards.md decisão
// do usuário: "importar pro banco, não precisa ler todas as linhas [toda vez]".

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

interface DashboardRow {
  nome: string;
  whatsapp_group_id: string;
}

const LOG_TABLE = "Controle de Mensagens";
const LOG_PAGE_SIZE = 1000; // teto do PostgREST por página
const LOG_CONCURRENCY = 8;  // paralelo, mesmo padrão de mapWithConcurrency usado nas outras edges
const LOG_MAX_PAGES = 500;  // teto de segurança (500k linhas) — loga se cortar

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

// "120363...-group" ou "120363...@g.us" -> "120363...@g.us" (forma canônica usada em
// client_dashboards e aceita pela UAZAPI). Vazio/lixo -> null.
function canonicalGroupId(raw: string | null | undefined): string | null {
  const id = (raw ?? "").trim().replace(/-group$/, "").replace(/@g\.us$/, "");
  return id ? `${id}@g.us` : null;
}

// Varre TODA a tabela de log (paginada, concorrente) e devolve os grupos distintos (id -> nome),
// pra pegar os grupos que a agência usa mas nunca foram cadastrados em client_dashboards. Falha
// ISOLADA (rede/timeout numa página) não derruba a função inteira — só aquela página fica de fora.
async function fetchLogGroups(baseUrl: string, serviceRoleKey: string): Promise<Map<string, string>> {
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const table = encodeURIComponent(LOG_TABLE);
  const select = encodeURIComponent(`Grupo,"Nome do Grupo"`);
  // order=id.asc é ESSENCIAL: sem ordem explícita o PostgREST não garante a mesma ordem de linhas
  // entre chamadas de Range separadas (tabela com inserts constantes) — sem isso, a paginação
  // pula/duplica linhas aleatoriamente e o merge final fica incompleto (bug real, achado testando
  // contra prod: só 16 grupos vieram do log em vez de dezenas).
  const baseQuery = `${baseUrl}/rest/v1/${table}?select=${select}&Grupo=not.is.null&order=id.asc`;

  const countRes = await fetch(baseQuery, { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } });
  if (!countRes.ok) {
    console.log(`[sync-whatsapp-groups] Log count falhou: HTTP ${countRes.status}`);
    return new Map();
  }
  const contentRange = countRes.headers.get("content-range"); // "0-0/99007"
  const total = contentRange ? Number(contentRange.split("/")[1]) : 0;
  if (!total || !Number.isFinite(total)) return new Map();

  const totalPages = Math.min(Math.ceil(total / LOG_PAGE_SIZE), LOG_MAX_PAGES);
  if (totalPages * LOG_PAGE_SIZE < total) {
    console.log(`[sync-whatsapp-groups] Log tem ${total} linhas — cortando em ${LOG_MAX_PAGES} páginas (teto de segurança).`);
  }

  // Páginas rodam em paralelo (LOG_CONCURRENCY workers) mas PRECISAM ser mescladas na ordem
  // original (0, 1, 2, ...) depois — não conforme terminam. O nome mais recente por grupo id
  // (grupo pode ser reaproveitado/renomeado pra outro cliente) tem que vencer, e isso só é
  // determinístico se o merge final seguir a ordem cronológica (id.asc) das páginas, não a ordem
  // de conclusão do fetch.
  const pages = await mapWithConcurrency(Array.from({ length: totalPages }, (_, i) => i), LOG_CONCURRENCY, async (page) => {
    const start = page * LOG_PAGE_SIZE;
    const end = start + LOG_PAGE_SIZE - 1;
    try {
      const res = await fetch(baseQuery, { headers: { ...headers, Range: `${start}-${end}` } });
      if (!res.ok) {
        console.log(`[sync-whatsapp-groups] Log página ${page} falhou: HTTP ${res.status}`);
        return [];
      }
      return (await res.json()) as { Grupo?: string; "Nome do Grupo"?: string }[];
    } catch (e) {
      console.log(`[sync-whatsapp-groups] Log página ${page} exceção:`, e instanceof Error ? e.message : String(e));
      return [];
    }
  });

  const merged = new Map<string, string>();
  for (const rows of pages) {
    for (const row of rows) {
      const id = canonicalGroupId(row.Grupo);
      if (id) merged.set(id, row["Nome do Grupo"] || id);
    }
  }
  return merged;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return json({ error: "Não autenticado" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. Validar caller via JWT (base própria, não a Agenciaf3f).
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      console.log("[sync-whatsapp-groups] Auth error:", authError?.message);
      return json({ error: "Sessão inválida" }, 401);
    }

    // 2. Ler as 2 fontes da base Agenciaf3f via service_role (REST direto — cross-project):
    // client_dashboards (nome limpo, autoridade) + log de mensagens (grupos não cadastrados lá).
    const agenciaf3fUrl = Deno.env.get("AGENCIAF3F_URL");
    const agenciaf3fServiceRoleKey = Deno.env.get("AGENCIAF3F_SERVICE_ROLE_KEY");
    if (!agenciaf3fUrl || !agenciaf3fServiceRoleKey) {
      console.error("[sync-whatsapp-groups] AGENCIAF3F_URL / AGENCIAF3F_SERVICE_ROLE_KEY não configurados");
      return json({ error: "Integração com a base Agenciaf3f não configurada" }, 500);
    }

    const dashboardsUrl =
      `${agenciaf3fUrl}/rest/v1/client_dashboards?select=nome,whatsapp_group_id&whatsapp_group_id=not.is.null`;
    const dashboardsResp = await fetch(dashboardsUrl, {
      headers: { apikey: agenciaf3fServiceRoleKey, Authorization: `Bearer ${agenciaf3fServiceRoleKey}` },
    });

    if (!dashboardsResp.ok) {
      const text = await dashboardsResp.text().catch(() => "");
      console.error("[sync-whatsapp-groups] Agenciaf3f REST error:", dashboardsResp.status, text);
      return json({ error: "Falha ao consultar a base Agenciaf3f" }, 502);
    }

    const dashboards = (await dashboardsResp.json()) as DashboardRow[];

    // Log de mensagens é best-effort: se falhar por inteiro, sincroniza só com client_dashboards
    // em vez de falhar tudo — a lista fica incompleta mas o sync não quebra.
    let logGroups = new Map<string, string>();
    try {
      logGroups = await fetchLogGroups(agenciaf3fUrl, agenciaf3fServiceRoleKey);
    } catch (e) {
      console.error("[sync-whatsapp-groups] fetchLogGroups falhou:", e instanceof Error ? e.message : String(e));
    }

    // Prioridade: LOG vence sobre client_dashboards. Grupo do WhatsApp pode ser reaproveitado
    // pra um cliente novo sem que o cadastro em client_dashboards seja atualizado (achado testando
    // contra prod: group_id X estava cadastrado como "Arthur" mas o log recente mostrava "Mari
    // Eiras" — o grupo tinha sido reciclado pro cliente atual). O nome mais recente no log de
    // mensagens reflete o subject atual do grupo no WhatsApp; client_dashboards só preenche
    // grupos que nunca mandaram mensagem (cliente novo, sem histórico ainda).
    const rows: { group_id: string; name: string; source: string }[] = [];
    const seen = new Set<string>();
    for (const [id, nome] of logGroups) {
      seen.add(id);
      rows.push({ group_id: id, name: nome, source: "message_log" });
    }
    for (const d of dashboards) {
      const id = canonicalGroupId(d.whatsapp_group_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({ group_id: id, name: d.nome, source: "client_dashboards" });
    }

    // 3. Upsert na tabela local (service_role, ignora RLS) — leitura depois é rápida e local.
    const dbClient = createClient(supabaseUrl, serviceRoleKey);
    if (rows.length > 0) {
      const { error: upsertError } = await dbClient
        .from("whatsapp_groups")
        .upsert(rows.map((r) => ({ ...r, synced_at: new Date().toISOString() })), { onConflict: "group_id" });
      if (upsertError) {
        console.error("[sync-whatsapp-groups] Upsert falhou:", upsertError.message);
        return json({ error: "Falha ao gravar grupos sincronizados" }, 500);
      }
    }

    return json({
      ok: true,
      synced: rows.length,
      from_dashboards: dashboards.length,
      from_log: logGroups.size,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sync-whatsapp-groups] Unexpected error:", msg);
    return json({ error: msg }, 500);
  }
});
