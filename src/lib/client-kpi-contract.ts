// Contrato de leitura entre a aba Otimizações e a aba Clientes.
// A aba Clientes (em construção em paralelo) ainda não tem tabela/schema — quando existir,
// trocar a implementação de fetchClientKpiConfigs por uma query real seguindo este mesmo shape.
// Cada regra de kpi carrega seu preset_bucket (FASE 1/2/3/L.T) — o limite é por conta E por preset,
// nunca aplicado a campanhas de outro preset na mesma conta.

export type PresetBucket = "FASE 1" | "FASE 2" | "FASE 3" | "L.T";

export type ClientKpiConfig = {
  clientId: string;
  clientName: string;
  adAccountId: string;
  kpi: { metric: string; operator: ">" | "<"; value: number; presetBucket: PresetBucket }[];
};

export async function fetchClientKpiConfigs(): Promise<ClientKpiConfig[]> {
  return [];
}
