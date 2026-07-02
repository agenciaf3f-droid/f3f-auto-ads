// Contrato de leitura entre a aba Otimizações e a aba Clientes.
// Monta ClientKpiConfig[] a partir das tabelas reais (clients/client_ad_accounts/client_kpi_rules).
// Cada regra de kpi carrega seu preset_bucket (FASE 1/2/3/L.T) — o limite é por conta E por preset,
// nunca aplicado a campanhas de outro preset na mesma conta.

import { listClients, listClientAdAccounts, listAllClientKpiRules } from "./clients";

export type PresetBucket = "FASE 1" | "FASE 2" | "FASE 3" | "L.T";

export type ClientKpiConfig = {
  clientId: string;
  clientName: string;
  adAccountId: string;
  kpi: {
    metric: string;
    operator: ">" | "<";
    value: number;
    presetBucket: PresetBucket;
    // Só populado (e relevante) pra presetBucket "L.T" — nome do produto salvo na regra,
    // usado por compareKpis pra restringir o match a campanhas desse produto específico.
    campaignNameFilter: string | null;
  }[];
};

export async function fetchClientKpiConfigs(): Promise<ClientKpiConfig[]> {
  const [clients, accounts, rules] = await Promise.all([
    listClients(),
    listClientAdAccounts(),
    listAllClientKpiRules(),
  ]);

  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const rulesByAccount = new Map<string, typeof rules>();
  for (const rule of rules) {
    const list = rulesByAccount.get(rule.client_ad_account_id) ?? [];
    list.push(rule);
    rulesByAccount.set(rule.client_ad_account_id, list);
  }

  const configs: ClientKpiConfig[] = [];
  for (const account of accounts) {
    const accountRules = rulesByAccount.get(account.id);
    if (!accountRules || accountRules.length === 0) continue; // sem regra = nada pra avaliar, evita fetch à toa

    const client = clientsById.get(account.client_id);
    if (!client) continue; // conta órfã (cliente removido) — não deveria acontecer via UI, mas não trava

    configs.push({
      clientId: account.client_id,
      clientName: client.name,
      adAccountId: account.ad_account_id,
      kpi: accountRules.map((r) => ({
        metric: r.metric_key,
        operator: r.comparator,
        value: r.threshold_value,
        presetBucket: r.preset_bucket as PresetBucket,
        campaignNameFilter: r.campaign_name_filter,
      })),
    });
  }

  return configs;
}
