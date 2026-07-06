import OptimizationBoard from "@/components/OptimizationBoard";

// Aba Otimizações: alertas de KPI pendentes (nunca tratados). O Histórico das campanhas já
// mantidas/desligadas vive na aba própria (HistoricoPage) — mesma engrenagem, outra fatia.
export default function OtimizacoesPage() {
  return <OptimizationBoard variant="pendentes" />;
}
