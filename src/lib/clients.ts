import { supabase } from "@/integrations/supabase/client";

// CRUD fino sobre Supabase para a aba Clientes. Mesmo estilo de src/lib/admin.ts.
// RLS exige user_id = auth.uid() no INSERT — por isso resolvemos o user antes de inserir.

export interface Client {
  id: string;
  user_id: string;
  name: string;
  notes: string | null;
  whatsapp_group_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientAdAccount {
  id: string;
  user_id: string;
  client_id: string;
  ad_account_id: string;
  ad_account_name: string | null;
  created_at: string;
}

export interface ClientLtProduct {
  id: string;
  user_id: string;
  client_id: string;
  product_name: string;
  created_at: string;
}

export interface ClientKpiRule {
  id: string;
  user_id: string;
  client_ad_account_id: string;
  preset_bucket: string;
  metric_key: string;
  comparator: ">" | "<";
  threshold_value: number;
  label_if_triggered: string;
  campaign_name_filter: string | null;
  created_at: string;
  updated_at: string;
}

async function currentUserId(): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Não autenticado");
  return user.id;
}

// ── clients ──────────────────────────────────────────────────────────────────
export async function listClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw new Error(error.message);
  return (data || []) as Client[];
}

export async function createClient(name: string, notes?: string, whatsappGroupId?: string): Promise<Client> {
  const user_id = await currentUserId();
  const { data, error } = await supabase
    .from("clients")
    .insert({ user_id, name, notes: notes || null, whatsapp_group_id: whatsappGroupId || null })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Client;
}

export async function updateClient(id: string, fields: { name?: string; notes?: string | null; whatsapp_group_id?: string | null }): Promise<void> {
  const { error } = await supabase.from("clients").update(fields).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteClient(id: string): Promise<void> {
  const { error } = await supabase.from("clients").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// Dashboards da base Agenciaf3f (client_dashboards) que já têm grupo de WhatsApp mapeado —
// usado pelo ClientForm para auto-casar por nome e pré-preencher whatsapp_group_id na criação.
export async function listClientDashboards(): Promise<{ nome: string; email: string | null; whatsapp_group_id: string }[]> {
  const { data, error } = await supabase.functions.invoke("list-client-dashboards", { body: {} });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data.dashboards;
}

// ── client_ad_accounts ───────────────────────────────────────────────────────
export async function listClientAdAccounts(clientId?: string): Promise<ClientAdAccount[]> {
  let query = supabase.from("client_ad_accounts").select("*");
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []) as ClientAdAccount[];
}

export async function linkAdAccount(
  clientId: string,
  adAccountId: string,
  adAccountName?: string | null,
): Promise<ClientAdAccount> {
  const user_id = await currentUserId();
  const { data, error } = await supabase
    .from("client_ad_accounts")
    .insert({ user_id, client_id: clientId, ad_account_id: adAccountId, ad_account_name: adAccountName || null })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error("Essa conta de anúncio já está vinculada a outro cliente.");
    }
    throw new Error(error.message);
  }
  return data as ClientAdAccount;
}

export async function unlinkAdAccount(id: string): Promise<void> {
  const { error } = await supabase.from("client_ad_accounts").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── client_lt_products (produtos L.T por cliente; alimentam o dropdown de produto nas regras L.T) ──
export async function listClientLtProducts(clientId: string): Promise<ClientLtProduct[]> {
  const { data, error } = await supabase
    .from("client_lt_products")
    .select("*")
    .eq("client_id", clientId)
    .order("product_name");
  if (error) throw new Error(error.message);
  return (data || []) as ClientLtProduct[];
}

export async function addClientLtProduct(clientId: string, productName: string): Promise<ClientLtProduct> {
  const user_id = await currentUserId();
  const { data, error } = await supabase
    .from("client_lt_products")
    .insert({ user_id, client_id: clientId, product_name: productName.trim() })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error("Esse produto já está cadastrado para este cliente.");
    }
    throw new Error(error.message);
  }
  return data as ClientLtProduct;
}

export async function deleteClientLtProduct(id: string): Promise<void> {
  const { error } = await supabase.from("client_lt_products").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── client_kpi_rules ─────────────────────────────────────────────────────────
export async function listClientKpiRules(clientAdAccountId: string): Promise<ClientKpiRule[]> {
  const { data, error } = await supabase
    .from("client_kpi_rules")
    .select("*")
    .eq("client_ad_account_id", clientAdAccountId);
  if (error) throw new Error(error.message);
  return (data || []) as ClientKpiRule[];
}

// Busca todas as regras do usuário de uma vez (RLS já escopa por auth.uid()) — usado pela
// aba Otimizações para montar configs sem N+1 query por conta.
export async function listAllClientKpiRules(): Promise<ClientKpiRule[]> {
  const { data, error } = await supabase.from("client_kpi_rules").select("*");
  if (error) throw new Error(error.message);
  return (data || []) as ClientKpiRule[];
}

export interface UpsertKpiRuleInput {
  client_ad_account_id: string;
  preset_bucket: string;
  metric_key: string;
  comparator: ">" | "<";
  threshold_value: number;
  label_if_triggered?: string;
  // Só usado (e exigido no FE) para preset_bucket "L.T": nome do produto/prefixo de campanha
  // que o gestor digita uma vez e o sistema reusa pra casar campanhas reais com essa regra.
  // FASE 1/2/3 não usam — bucket fixo já basta.
  campaign_name_filter?: string | null;
}

export async function upsertKpiRule(rule: UpsertKpiRuleInput): Promise<void> {
  const user_id = await currentUserId();
  const { error } = await supabase
    .from("client_kpi_rules")
    .upsert(
      {
        user_id,
        client_ad_account_id: rule.client_ad_account_id,
        preset_bucket: rule.preset_bucket,
        metric_key: rule.metric_key,
        comparator: rule.comparator,
        threshold_value: rule.threshold_value,
        label_if_triggered: rule.label_if_triggered || "ruim",
        campaign_name_filter: rule.campaign_name_filter || "",
      },
      { onConflict: "client_ad_account_id,preset_bucket,metric_key,campaign_name_filter" },
    );
  if (error) throw new Error(error.message);
}

export async function deleteKpiRule(id: string): Promise<void> {
  const { error } = await supabase.from("client_kpi_rules").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
