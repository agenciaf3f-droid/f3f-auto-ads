// Helper best-effort p/ gravar cache de descoberta Meta (tabela meta_discovery_cache).
// Chamado pelas edges de descoberta DEPOIS de montar o resultado, com o service_role.
// Nunca lança: falha só loga e a edge segue retornando normal ao frontend.
import { createClient } from "jsr:@supabase/supabase-js@2";

export async function cacheDiscovery(kind: string, accountId: string, data: unknown): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceRoleKey) {
      console.log(`[discovery-cache] envs ausentes; pulando ${kind}/${accountId}`);
      return;
    }
    // accountId vem do body do usuário (funcs de descoberta não fazem getUser) e é
    // gravado via SERVICE_ROLE. Sem validação, um account_id arbitrário criaria linhas
    // ilimitadas em meta_discovery_cache. Aceita só 'shared', act_<num> ou <num>.
    if (accountId !== "shared" && !/^(act_\d+|\d+)$/.test(accountId)) {
      console.log(`[discovery-cache] account_id inválido; pulando ${kind}/${accountId}`);
      return;
    }
    const client = createClient(url, serviceRoleKey);
    // PK composta (kind, account_id) resolve o ON CONFLICT automaticamente.
    // updated_at explícito: DEFAULT now() só dispara no INSERT, não no UPDATE do upsert.
    const { error } = await client
      .from("meta_discovery_cache")
      .upsert({ kind, account_id: accountId, data, updated_at: new Date().toISOString() });
    if (error) console.log(`[discovery-cache] upsert falhou ${kind}/${accountId}: ${error.message}`);
  } catch (e) {
    console.log(`[discovery-cache] erro ${kind}/${accountId}: ${(e as Error).message}`);
  }
}
