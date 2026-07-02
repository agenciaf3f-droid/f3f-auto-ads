// Contrato de leitura entre a aba Otimizações e a aba Clientes.
// A aba Clientes (em construção em paralelo) ainda não tem tabela/schema — quando existir,
// trocar a implementação de fetchClientKpiConfigs por uma query real seguindo este mesmo shape.

export type ClientKpiConfig = {
  clientId: string;
  clientName: string;
  adAccountId: string;
  kpi: { metric: string; operator: ">" | "<"; value: number }[];
};

export async function fetchClientKpiConfigs(): Promise<ClientKpiConfig[]> {
  return [];
}
