import { describe, it, expect } from "vitest";
import {
  placementKindFor,
  placementGroupsFor,
  allPlacementKeys,
  buildPlacementsObject,
  applyPlacements,
  type PlacementsPayload,
} from "./placements";

describe("placementKindFor", () => {
  it("mapeia destination_type/optimization_goal → preset kind", () => {
    expect(placementKindFor("INSTAGRAM_PROFILE")).toBe("FASE1");
    expect(placementKindFor("WHATSAPP")).toBe("FASE3");
    expect(placementKindFor("WEBSITE")).toBe("LT");
    expect(placementKindFor("ON_VIDEO")).toBe("FASE2");
    expect(placementKindFor(undefined, "THRUPLAY")).toBe("FASE2");
    expect(placementKindFor("SOMETHING_ELSE")).toBe("LT"); // fallback
  });
});

describe("guardrails por preset", () => {
  it("FASE 1 só oferece Instagram", () => {
    const groups = placementGroupsFor("FASE1");
    expect(groups.map((g) => g.platform)).toEqual(["instagram"]);
  });
  it("FASE 3 não oferece Audience Network nem Messenger", () => {
    const platforms = placementGroupsFor("FASE3").map((g) => g.platform);
    expect(platforms).not.toContain("audience_network");
    expect(platforms).not.toContain("messenger");
    expect(platforms).toContain("facebook");
    expect(platforms).toContain("instagram");
  });
  it("FASE 2 não oferece Audience Network", () => {
    expect(placementGroupsFor("FASE2").map((g) => g.platform)).not.toContain("audience_network");
  });
  it("L.T oferece as 4 plataformas", () => {
    expect(placementGroupsFor("LT").map((g) => g.platform)).toEqual([
      "facebook", "instagram", "audience_network", "messenger",
    ]);
  });
  it("L.T não expõe right_hand_column nem search (desktop-only/restrito)", () => {
    const fb = placementGroupsFor("LT").find((g) => g.platform === "facebook")!;
    const keys = fb.positions.map((p) => p.key);
    expect(keys).not.toContain("right_hand_column");
    expect(keys).not.toContain("search");
  });
});

describe("buildPlacementsObject", () => {
  it("todos selecionados → undefined (AUTOMÁTICO)", () => {
    const groups = placementGroupsFor("FASE3");
    const all = new Set(allPlacementKeys(groups));
    expect(buildPlacementsObject(groups, all)).toBeUndefined();
  });
  it("nada selecionado → undefined (inválido; form barra)", () => {
    const groups = placementGroupsFor("FASE3");
    expect(buildPlacementsObject(groups, new Set())).toBeUndefined();
  });
  it("subconjunto → objeto explícito só com o ligado", () => {
    const groups = placementGroupsFor("FASE3");
    // Só IG Feed + IG Reels ligados
    const sel = new Set(["instagram:stream", "instagram:reels"]);
    const out = buildPlacementsObject(groups, sel);
    expect(out).toEqual<PlacementsPayload>({
      publisher_platforms: ["instagram"],
      instagram_positions: ["stream", "reels"],
    });
  });
  it("subconjunto multi-plataforma → publisher_platforms recomputado", () => {
    const groups = placementGroupsFor("FASE3");
    const sel = new Set(["facebook:feed", "instagram:stream"]);
    const out = buildPlacementsObject(groups, sel)!;
    expect(out.publisher_platforms.sort()).toEqual(["facebook", "instagram"]);
    expect(out.facebook_positions).toEqual(["feed"]);
    expect(out.instagram_positions).toEqual(["stream"]);
  });
});

describe("applyPlacements", () => {
  it("automático (placements null) → não seta nada; limpa herdados (form vence saved audience)", () => {
    const targeting: Record<string, unknown> = {
      geo_locations: { countries: ["BR"] },
      publisher_platforms: ["facebook"], // vazado de público salvo
      facebook_positions: ["feed"],
    };
    const r = applyPlacements(targeting, null, "FASE1");
    expect(r).toEqual({ ok: true });
    expect(targeting.publisher_platforms).toBeUndefined();
    expect(targeting.facebook_positions).toBeUndefined();
    expect(targeting.geo_locations).toEqual({ countries: ["BR"] }); // preserva o resto
  });

  it("manual válido → aplica e recomputa publisher_platforms", () => {
    const targeting: Record<string, unknown> = { geo_locations: { countries: ["BR"] } };
    const r = applyPlacements(
      targeting,
      { publisher_platforms: ["instagram"], instagram_positions: ["stream", "reels"] },
      "FASE1",
    );
    expect(r).toEqual({ ok: true });
    expect(targeting.publisher_platforms).toEqual(["instagram"]);
    expect(targeting.instagram_positions).toEqual(["stream", "reels"]);
  });

  it("plataforma inválida pro preset (AN em FASE 3) → erro", () => {
    const targeting: Record<string, unknown> = {};
    const r = applyPlacements(
      targeting,
      { publisher_platforms: ["audience_network"], audience_network_positions: ["classic"] },
      "FASE3",
    );
    if (r.ok) throw new Error("esperava falha");
    expect(r.error).toMatch(/audience_network/);
    expect(targeting.publisher_platforms).toBeUndefined(); // não aplicou
  });

  it("posição inválida dentro de plataforma válida → erro", () => {
    const r = applyPlacements(
      {},
      { publisher_platforms: ["instagram"], instagram_positions: ["stream", "banner_gigante"] },
      "FASE1",
    );
    if (r.ok) throw new Error("esperava falha");
    expect(r.error).toMatch(/banner_gigante/);
  });

  it("FASE 1 com Facebook → erro (só IG permitido)", () => {
    const r = applyPlacements(
      {},
      { publisher_platforms: ["facebook"], facebook_positions: ["feed"] },
      "FASE1",
    );
    if (r.ok) throw new Error("esperava falha");
    expect(r.error).toMatch(/facebook/);
  });

  it("placements sem nenhuma posição válida → erro 'nenhum posicionamento'", () => {
    const r = applyPlacements({}, { publisher_platforms: [] }, "LT");
    if (r.ok) throw new Error("esperava falha");
    expect(r.error).toMatch(/nenhum posicionamento/);
  });

  it("strip-always: limpa placements herdados mesmo em manual antes de aplicar", () => {
    const targeting: Record<string, unknown> = {
      publisher_platforms: ["audience_network"],
      audience_network_positions: ["classic"],
      messenger_positions: ["messenger_home"],
    };
    applyPlacements(
      targeting,
      { publisher_platforms: ["instagram"], instagram_positions: ["stream"] },
      "FASE3",
    );
    expect(targeting.publisher_platforms).toEqual(["instagram"]);
    expect(targeting.audience_network_positions).toBeUndefined();
    expect(targeting.messenger_positions).toBeUndefined();
  });
});
