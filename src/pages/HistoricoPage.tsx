import OptimizationBoard from "@/components/OptimizationBoard";

// Aba Histórico: campanhas já mantidas/desligadas, reavaliadas ao vivo. Mesma engrenagem da aba
// Otimizações (OptimizationBoard) — só muda a fatia renderizada.
export default function HistoricoPage() {
  return <OptimizationBoard variant="historico" />;
}
