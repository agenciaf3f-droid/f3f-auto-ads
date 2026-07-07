// Posicionamentos (Meta placements) por preset — FONTE DA VERDADE do FRONT.
//
// ⚠ ESPELHO da lógica no edge `supabase/functions/meta-publish/index.ts`
// (PLACEMENTS_VALID_BY_KIND + applyPlacements). Front e edge NÃO compartilham código
// (Vite vs Deno), então mantenha as listas de posição por preset e os tokens em sincronia.
// A lógica pura (applyPlacements/buildPlacementsObject) é testada aqui em placements.test.ts;
// o edge inlina uma cópia idêntica de applyPlacements.
//
// Regra de entrega (decisão do usuário):
//   - TODOS os posicionamentos válidos ligados (default) → envia AUTOMÁTICO (omite placements
//     = Advantage+ Placements; melhor entrega; bate o gabarito real).
//   - Usuário desligou algum → envia EXPLÍCITO só os ligados restantes (publisher_platforms +
//     *_positions). Isso desliga o Advantage+ Placements (esperado).
//
// ⚠ Tokens de TARGETING (input da Graph API), NÃO os de reporting/breakdown:
//   IG Feed = "stream" (não "instagram_feed"); IG Stories = "story" (não "instagram_stories").

export type PlacementPlatform = "facebook" | "instagram" | "audience_network" | "messenger";
export type PlacementPresetKind = "FASE1" | "FASE2" | "FASE3" | "LT";

export interface PlacementPosition { key: string; label: string }
export interface PlacementGroup { platform: PlacementPlatform; label: string; positions: PlacementPosition[] }

export const PLATFORM_POSITION_FIELD: Record<PlacementPlatform, string> = {
  facebook: "facebook_positions",
  instagram: "instagram_positions",
  audience_network: "audience_network_positions",
  messenger: "messenger_positions",
};

// Instagram — Feed/Stories/Reels sempre; Explorar só onde confirmado no gabarito.
// (Corte conservador — lição FASE 1: não sobe token não-confirmado. FASE 1/FASE 3 sem explore.)
const IG_GROUP = (withExplore = true): PlacementGroup => ({
  platform: "instagram",
  label: "Instagram",
  positions: [
    { key: "stream", label: "Feed" },
    { key: "story", label: "Stories" },
    { key: "reels", label: "Reels" },
    ...(withExplore ? [{ key: "explore", label: "Explorar" }] : []),
  ],
});

// Grupos por preset — SÓ posicionamentos VÁLIDOS pro objetivo (guardrail: o gestor
// nunca vê um que quebra/silencia a entrega).
export const PLACEMENTS_BY_KIND: Record<PlacementPresetKind, PlacementGroup[]> = {
  // FASE 1 (PROFILE_VISIT / INSTAGRAM_PROFILE): destino é o perfil IG → SÓ Instagram.
  // Oferecer Facebook aqui degrada a entrega SEM erro (a lição FASE 1). Sem explore (não confirmado).
  FASE1: [IG_GROUP(false)],

  // FASE 2 (THRUPLAY / ON_VIDEO): só posições com vídeo. SEM Audience Network
  // (VV de baixa qualidade contamina o público VV50%).
  FASE2: [
    { platform: "facebook", label: "Facebook", positions: [
      { key: "feed", label: "Feed" },
      { key: "story", label: "Stories" },
      { key: "facebook_reels", label: "Reels" },
      { key: "instream_video", label: "Vídeos in-stream" },
      { key: "video_feeds", label: "Feeds de vídeo" },
    ] },
    IG_GROUP(),
  ],

  // FASE 3 (CONVERSATIONS / WHATSAPP CTWA): FB + IG. SEM Audience Network e SEM Messenger
  // (CTWA inelegível nesses → entrega furada). Corte conservador: só feed/stories/reels
  // (gabarito real entregou só nesses; marketplace/video_feeds/explore não confirmados).
  FASE3: [
    { platform: "facebook", label: "Facebook", positions: [
      { key: "feed", label: "Feed" },
      { key: "story", label: "Stories" },
      { key: "facebook_reels", label: "Reels" },
    ] },
    IG_GROUP(false),
  ],

  // L.T (OFFSITE_CONVERSIONS / WEBSITE): FB + IG + Audience Network + Messenger.
  // right_hand_column/search excluídos de propósito (desktop-only / formato restrito →
  // drop silencioso pra criativo de vídeo/reel).
  LT: [
    { platform: "facebook", label: "Facebook", positions: [
      { key: "feed", label: "Feed" },
      { key: "marketplace", label: "Marketplace" },
      { key: "story", label: "Stories" },
      { key: "facebook_reels", label: "Reels" },
      { key: "instream_video", label: "Vídeos in-stream" },
      { key: "video_feeds", label: "Feeds de vídeo" },
    ] },
    IG_GROUP(),
    { platform: "audience_network", label: "Audience Network", positions: [
      { key: "classic", label: "Nativo, banner e interstitial" },
      { key: "rewarded_video", label: "Vídeos premiados" },
    ] },
    { platform: "messenger", label: "Messenger", positions: [
      { key: "messenger_home", label: "Caixa de entrada" },
      { key: "story", label: "Stories" },
    ] },
  ],
};

export function placementKindFor(destinationType?: string, optimizationGoal?: string): PlacementPresetKind {
  if (destinationType === "INSTAGRAM_PROFILE") return "FASE1";
  if (destinationType === "WHATSAPP") return "FASE3";
  if (destinationType === "WEBSITE") return "LT";
  if (destinationType === "ON_VIDEO" || optimizationGoal === "THRUPLAY") return "FASE2";
  return "LT"; // fallback abrangente (nunca deveria cair aqui nos 4 presets)
}

export function placementGroupsFor(kind: PlacementPresetKind): PlacementGroup[] {
  return PLACEMENTS_BY_KIND[kind];
}

// Chave estável "platform:position" (usada no estado de seleção do form).
export function placementKey(platform: PlacementPlatform, position: string): string {
  return `${platform}:${position}`;
}

export function allPlacementKeys(groups: PlacementGroup[]): string[] {
  return groups.flatMap((g) => g.positions.map((p) => placementKey(g.platform, p.key)));
}

export type PlacementsPayload = {
  publisher_platforms: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  audience_network_positions?: string[];
  messenger_positions?: string[];
};

// Constrói o objeto de placements EXPLÍCITO a partir das chaves selecionadas.
// Retorna undefined quando: seleção == TODOS (→ AUTOMÁTICO) OU nada selecionado
// (inválido — o form barra antes; undefined vira automático como fallback seguro).
export function buildPlacementsObject(
  groups: PlacementGroup[],
  selectedKeys: Set<string>,
): PlacementsPayload | undefined {
  const allKeys = allPlacementKeys(groups);
  const selectedCount = allKeys.filter((k) => selectedKeys.has(k)).length;
  if (selectedCount === 0) return undefined;              // inválido (form barra) → fallback auto
  if (selectedCount === allKeys.length) return undefined; // automático (todos ligados)

  const byPlatform: Partial<Record<PlacementPlatform, string[]>> = {};
  for (const g of groups) {
    const pos = g.positions
      .filter((p) => selectedKeys.has(placementKey(g.platform, p.key)))
      .map((p) => p.key);
    if (pos.length) byPlatform[g.platform] = pos;
  }
  const publisher_platforms = Object.keys(byPlatform) as PlacementPlatform[];
  const out: PlacementsPayload = { publisher_platforms };
  for (const platform of publisher_platforms) {
    (out as Record<string, unknown>)[PLATFORM_POSITION_FIELD[platform]] = byPlatform[platform];
  }
  return out;
}

// Conjuntos de posições VÁLIDAS por plataforma, pro preset. Usado na re-validação.
export function validPositionsByPlatform(kind: PlacementPresetKind): Partial<Record<PlacementPlatform, Set<string>>> {
  const map: Partial<Record<PlacementPlatform, Set<string>>> = {};
  for (const g of PLACEMENTS_BY_KIND[kind]) map[g.platform] = new Set(g.positions.map((p) => p.key));
  return map;
}

// Remove QUALQUER campo de placement herdado do targeting (ex.: vazado de um público salvo).
export function stripPlacementFields(targeting: Record<string, unknown>): void {
  delete targeting.publisher_platforms;
  delete targeting.facebook_positions;
  delete targeting.instagram_positions;
  delete targeting.audience_network_positions;
  delete targeting.messenger_positions;
}

// Aplica placements ao targeting do adset (mutação in-place). ESPELHO da cópia no edge.
//   - Sempre limpa placements herdados primeiro (form vence público salvo; "auto" vira
//     100% automático de verdade, batendo o gabarito).
//   - Sem placements → AUTOMÁTICO (nada mais a fazer).
//   - Com placements → valida cada posição contra o conjunto válido do preset; se qualquer
//     plataforma/posição for inválida → erro (defense-in-depth; a UI já filtra, isto pega
//     adulteração/bug). Recomputa publisher_platforms a partir das posições enviadas.
export function applyPlacements(
  targeting: Record<string, unknown>,
  placements: PlacementsPayload | null | undefined,
  kind: PlacementPresetKind,
): { ok: boolean; error?: string } {
  stripPlacementFields(targeting);
  if (!placements) return { ok: true }; // automático

  const valid = validPositionsByPlatform(kind);
  const applied: Partial<Record<PlacementPlatform, string[]>> = {};
  const errors: string[] = [];

  for (const platform of Object.keys(PLATFORM_POSITION_FIELD) as PlacementPlatform[]) {
    const arr = (placements as Record<string, unknown>)[PLATFORM_POSITION_FIELD[platform]];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const validSet = valid[platform];
    if (!validSet) { errors.push(`plataforma "${platform}" inválida para o preset`); continue; }
    const invalid = arr.filter((p) => !validSet.has(p as string));
    if (invalid.length) errors.push(`posições inválidas em ${platform}: ${invalid.join(", ")}`);
    applied[platform] = arr as string[];
  }

  if (errors.length) return { ok: false, error: errors.join("; ") };
  const platforms = Object.keys(applied) as PlacementPlatform[];
  if (platforms.length === 0) return { ok: false, error: "nenhum posicionamento válido selecionado" };

  targeting.publisher_platforms = platforms;
  for (const platform of platforms) {
    targeting[PLATFORM_POSITION_FIELD[platform]] = applied[platform];
  }
  return { ok: true };
}
