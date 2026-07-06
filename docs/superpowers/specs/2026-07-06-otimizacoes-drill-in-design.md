# Otimizações — Drill-in navegável (campanha → conjuntos → criativos)

## Objetivo
Substituir o dialog de "Desligar" por **navegação drill-in** dentro do `OptimizationBoard`:
clicar numa campanha **entra** numa view só com os conjuntos dela (sem as outras campanhas);
clicar num conjunto entra nos criativos dele; "‹ Voltar" sobe um nível. Pausar acontece **por nó**
— só aquele conjunto OU aquele criativo daquela campanha, **nunca a campanha inteira** — e registra
a ação, mandando a campanha pro Histórico.

## Níveis (estado interno no board, sem rota nova)
`drill: null | { campaign } | { campaign, adset }`

- **Nível 0 — Campanhas:** cards atuais (refinados). Corpo do card clicável (chevron ›) → entra na
  campanha. "Manter" continua no card. **Some** o botão "Desligar".
- **Nível 1 — Conjuntos:** header `‹ Voltar` + breadcrumb (cliente / campanha).
  `fetchNodeInsights(campaign.campaignId, "adset", range)`. Cada linha: nome, status, **métrica do
  KPI** (`computeNodeMetricValue`), botão **Pausar**, chevron › (entra nos criativos).
- **Nível 2 — Criativos:** `‹ Voltar` + breadcrumb (campanha / conjunto).
  `fetchNodeInsights(campaign.campaignId, "ad", range)` **filtrado por `adsetId === adset.id`**.
  Linha: nome, status, métrica, **Pausar**. Folha (não desce mais).

## Pausar (por nó)
`pausarNo(node)`: `pauseCampaign(accessToken, node.id)` (a Graph API pausa qualquer id: campaign/
adset/ad) → marca o nó como pausado na view (`effective_status = "PAUSED"`, botão vira "Pausado"
disabled) → `recordAction(campaignViolation, "paused")` → campanha sai de Pendentes / entra no
Histórico. Só aquele nó é pausado na Meta. Erro transiente/rate-limit: toast acionável, nó volta
ao estado ativo (não marca pausado).

## Contrato de dados (edge — mudança pequena)
`meta-node-insights` **hoje não devolve `adset_id` por criativo** (busca no `structureFields` de
`ad` mas não mapeia pro output). Expor:
- `NodeOut += adsetId?: string` — no map do level `ad`: `adsetId: n.adset_id`. Level `adset` deixa
  `undefined`.
- `src/lib/meta-api.ts` `MetaNodeInsight += adsetId?: string`.
Sem isso o Nível 2 não consegue filtrar os criativos do conjunto clicado.

## Design / UX (refino)
- Breadcrumb clicável (cliente › campanha › conjunto) pra subir níveis; `‹ Voltar` explícito.
- Linhas de nó: chip de métrica com **cor de severidade**, status pill, botão Pausar (destructive)
  ou "Pausado" (disabled) quando já `PAUSED`.
- Transições suaves (fade), spinner de loading por nível, estado vazio ("Nenhum conjunto/criativo").
- Afordância de "entrar" (chevron ›) e "voltar" clara; hierarquia tipográfica e espaçamento limpos.
- Aplica nas **duas abas** (Otimizações e Histórico) — mesmo board, mesma navegação.

## Reuso (não reinventar)
`fetchNodeInsights`, `computeNodeMetricValue`, `formatMetricValue`, `recordAction`, `getMetricDef`,
cores de severidade (`emphasizeRed`/amarelo). `buildOptimizationView` e a lógica de Pendentes/
Histórico **não mudam**.

## Aposenta
Dialog de "Desligar" e seu estado (`confirmCampaign` como gatilho de dialog, `nodeLevel`, `nodes`,
`selectedNodeIds`, `nodesLoading`, `confirmingPause`, `toggleNode`, o effect `loadNodes`, o
`handleDesligar` baseado em checkbox). Substituídos pelo estado `drill` + `pausarNo`.

## Fora de escopo
- Não paginar além do `limit=200` já existente na edge.
- Não mexer no fluxo de publicação nem em outras abas.
- Não mudar RLS/isolamento (já por-gestor).

## Verificação
`npx tsc -p tsconfig.app.json` limpo · `npm run test` · `npm run build`. Depois: review eu + advisor.
