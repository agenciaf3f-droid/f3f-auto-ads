import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractDriveFileId, buildDriveApiUrl } from "../_shared/drive.ts";
import { assertSafeDriveUrl } from "../_shared/url-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const fetchMeta = (url: string, timeoutMs = 15_000) =>
  fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

function normalizeInstagramUrl(url: string): { normalized: string; type: string; shortcode: string | null; error?: string } {
  let cleaned = url.trim();
  try {
    const urlObj = new URL(cleaned);
    cleaned = `${urlObj.origin}${urlObj.pathname}`;
  } catch {
    return { normalized: cleaned, type: "invalid", shortcode: null, error: "URL inválida" };
  }
  cleaned = cleaned.replace(/\/+$/, "");

  const postMatch = cleaned.match(/instagram\.com\/(?:.*\/)?(p)\/([A-Za-z0-9_-]+)/);
  const reelMatch = cleaned.match(/instagram\.com\/(?:.*\/)?(reels?|reel)\/([A-Za-z0-9_-]+)/);
  const tvMatch = cleaned.match(/instagram\.com\/(?:.*\/)?(tv)\/([A-Za-z0-9_-]+)/);
  const storyMatch = cleaned.match(/instagram\.com\/stories\/([^/]+)\/(\d+)/);
  const profileMatch = cleaned.match(/instagram\.com\/([A-Za-z0-9_.]+)\/?$/);

  if (postMatch) return { normalized: cleaned, type: "post", shortcode: postMatch[2] };
  if (reelMatch) return { normalized: cleaned, type: "reel", shortcode: reelMatch[2] };
  if (tvMatch) return { normalized: cleaned, type: "tv", shortcode: tvMatch[2] };
  if (storyMatch) return { normalized: cleaned, type: "story", shortcode: null, error: "Stories do Instagram não são suportados como criativo. Use Post ou Reel." };
  if (profileMatch && !cleaned.includes("/p/") && !cleaned.includes("/reel") && !cleaned.includes("/tv/")) {
    return { normalized: cleaned, type: "profile", shortcode: null, error: "Link de perfil do Instagram não é suportado. Use o link de um Post ou Reel específico." };
  }
  return { normalized: cleaned, type: "unknown", shortcode: null, error: "Formato de link do Instagram não reconhecido. Use: instagram.com/p/XXXX ou instagram.com/reel/XXXX" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t0 = Date.now();
  const timings: { step: string; ms: number }[] = [];
  function mark(step: string, start: number) {
    const ms = Date.now() - start;
    timings.push({ step, ms });
    console.log(`[validate-creative] ${step}: ${ms}ms`);
  }

  try {
    const { access_token, ad_account_id, creative_link, creative_type, ig_account_id } = await req.json();

    if (!access_token || !creative_link) {
      return new Response(JSON.stringify({ ok: false, error: "access_token e creative_link são obrigatórios" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isIgLink = creative_type === "instagram" || (!creative_type && creative_link.includes("instagram.com"));
    const isDriveLink = creative_type === "drive" || (!creative_type && (creative_link.includes("drive.google.com") || creative_link.includes("docs.google.com")));

    if (isIgLink) {
      const tParse = Date.now();
      const parsed = normalizeInstagramUrl(creative_link);
      mark("parse_url", tParse);
      console.log(`[validate-creative] link_original=${creative_link}, normalized=${parsed.normalized}, type=${parsed.type}, shortcode=${parsed.shortcode}`);

      if (parsed.error) {
        return new Response(JSON.stringify({
          ok: false, error: parsed.error, parsed_type: parsed.type, normalized_url: parsed.normalized,
          suggest_drive: parsed.type === "story" || parsed.type === "profile", timings,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (!parsed.shortcode) {
        return new Response(JSON.stringify({
          ok: false, error: "Não foi possível extrair o shortcode do link.", parsed_type: parsed.type, normalized_url: parsed.normalized, timings,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const shortcode = parsed.shortcode;

      // === FAST PATH: If ig_account_id is known, query media directly (no page scan) ===
      if (ig_account_id) {
        const tDirect = Date.now();
        console.log(`[validate-creative] FAST PATH: querying media directly from ig_account_id=${ig_account_id}`);
        let mediaUrl: string | null = `https://graph.facebook.com/v25.0/${ig_account_id}/media?fields=id,shortcode,permalink&limit=50&access_token=${access_token}`;
        let mediaApiCalls = 0;
        let mediaChecked = 0;

        while (mediaUrl && mediaChecked < 500) { // alinhado com o scan do publish (resolveInstagramMediaId < 500) — reduz falso "post não encontrado"
          mediaApiCalls++;
          const mediaRes = await fetchMeta(mediaUrl);
          const mediaData = await mediaRes.json();

          if (mediaData.error) {
            console.log(`[validate-creative] FAST PATH media error: ${mediaData.error.message}`);
            // Fall through to page scan
            break;
          }

          if (mediaData.data) {
            mediaChecked += mediaData.data.length;
            const scLc = shortcode.toLowerCase();
            const found = mediaData.data.find((m: any) => (m.shortcode || "").toLowerCase() === scLc || (m.permalink || "").toLowerCase().includes(scLc));
            if (found) {
              mark("search_media_direct", tDirect);
              mark("TOTAL", t0);
              console.log(`[validate-creative] FAST PATH FOUND after ${mediaApiCalls} API calls: media_id=${found.id}`);
              return new Response(JSON.stringify({
                ok: true, creative_resolved: true,
                instagram_media_id: found.id, ig_account_id,
                content_type: parsed.type, source: "direct", timings,
              }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }
          mediaUrl = mediaData.paging?.next || null;
        }
        mark("search_media_direct", tDirect);
        console.log(`[validate-creative] FAST PATH: not found after ${mediaApiCalls} calls, ${mediaChecked} items checked.`);
        // ig_account_id conhecido (FASE 1/3): se o post não está no IG DESTA conta,
        // NÃO varrer todas as páginas (slow path é catastrófico — varre cada IG até
        // 200 medias; com 6 criativos paralelo trava + rate limit). Retorna não-achado.
        mark("TOTAL", t0);
        return new Response(JSON.stringify({
          ok: false,
          error: `Post não encontrado nas publicações recentes do Instagram desta conta. Confira se o link está certo e se é um post desta conta — ou use "Arquivo (Google Drive)".`,
          suggest_drive: true, shortcode_searched: shortcode, media_checked: mediaChecked, timings,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // === SLOW PATH: Scan pages (apenas quando NÃO há ig_account_id) ===
      const tPages = Date.now();
      const allPages: any[] = [];
      let pagesUrl: string | null = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,instagram_business_account{id}&limit=25&access_token=${access_token}`;
      let pageRequests = 0;
      while (pagesUrl) {
        pageRequests++;
        const pagesRes = await fetchMeta(pagesUrl);
        const pagesData = await pagesRes.json();
        if (pagesData.error) {
          mark("fetch_pages", tPages);
          console.log(`[validate-creative] fetch_pages ERROR: ${pagesData.error.message}`);
          return new Response(JSON.stringify({
            ok: false, error: `Erro ao buscar páginas: ${pagesData.error.message}`, timings,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (pagesData.data) allPages.push(...pagesData.data);
        pagesUrl = pagesData.paging?.next || null;
        if (allPages.length >= 100) break;
      }
      mark("fetch_pages", tPages);
      console.log(`[validate-creative] ${allPages.length} pages fetched in ${pageRequests} request(s)`);

      if (allPages.length === 0) {
        return new Response(JSON.stringify({
          ok: false, error: "Nenhuma página encontrada. Verifique permissões.", suggest_drive: true, timings,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const tSearch = Date.now();
      const pagesWithIg = allPages.filter(p => p.instagram_business_account);
      // Skip IG accounts already checked in fast path
      const filteredPages = ig_account_id
        ? pagesWithIg.filter(p => p.instagram_business_account.id !== ig_account_id)
        : pagesWithIg;
      let mediaApiCalls = 0;

      for (const page of filteredPages) {
        const igAccountId = page.instagram_business_account.id;
        let mediaUrl: string | null = `https://graph.facebook.com/v25.0/${igAccountId}/media?fields=id,shortcode,permalink&limit=30&access_token=${access_token}`;
        let mediaChecked = 0;
        while (mediaUrl && mediaChecked < 200) {
          mediaApiCalls++;
          const mediaRes = await fetchMeta(mediaUrl);
          const mediaData = await mediaRes.json();

          if (mediaData.data) {
            mediaChecked += mediaData.data.length;
            const found = mediaData.data.find((m: any) => m.shortcode === shortcode || m.permalink?.includes(shortcode));
            if (found) {
              mark("search_media", tSearch);
              mark("TOTAL", t0);
              console.log(`[validate-creative] FOUND after ${mediaApiCalls} media API calls: shortcode=${shortcode} on page=${page.name}, ig=${igAccountId}, media_id=${found.id}`);
              return new Response(JSON.stringify({
                ok: true, creative_resolved: true,
                instagram_media_id: found.id, page_id: page.id, page_name: page.name,
                ig_account_id: igAccountId, content_type: parsed.type, source: "page_scan", timings,
              }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }
          mediaUrl = mediaData.paging?.next || null;
        }
      }

      mark("search_media", tSearch);
      mark("TOTAL", t0);
      console.log(`[validate-creative] NOT FOUND after ${mediaApiCalls} media API calls in ${filteredPages.length} IG accounts`);
      const pageNames = pagesWithIg.map((p: any) => p.name).join(", ");
      return new Response(JSON.stringify({
        ok: false,
        error: `Post não encontrado nas contas Instagram conectadas (${pageNames}). Use "Arquivo (Google Drive)" como alternativa.`,
        suggest_drive: true, parsed_type: parsed.type, shortcode_searched: shortcode,
        pages_with_ig: pagesWithIg.length, media_api_calls: mediaApiCalls, timings,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (isDriveLink) {
      const tDrive = Date.now();
      const fileId = extractDriveFileId(creative_link);
      const driveApiKey = Deno.env.get("GOOGLE_DRIVE_API_KEY");

      // Espelha o caminho PRIMÁRIO do publish: baixa via API key do Drive
      // (googleapis.com/.../alt=media&key=). A API key é anônima → só lê arquivo
      // "qualquer pessoa com o link". Arquivo privado → 403 → publish falha igual.
      // Testamos aqui (Range: só os primeiros bytes, não baixa o arquivo inteiro)
      // pra FALHAR CEDO na validação em vez de quebrar no publish.
      if (fileId && driveApiKey) {
        try {
          const apiUrl = buildDriveApiUrl(fileId, driveApiKey);
          const ERR_STATUSES = [401, 403, 404, 429];
          // Página anti-abuso / rate-limit do Google (muitos downloads anônimos em surto): NÃO é
          // "arquivo privado". Vem como HTTP 429 OU 401/403 com HTML "<title>Sorry...".
          const DRIVE_RATELIMIT_RE = /sorry|unusual traffic|automated queries|too many requests|try again later/i;
          const RETRY_BACKOFFS_MS = [1500, 4000, 7000];
          const fetchDriveWithBody = async () => {
            const r = await fetch(apiUrl, { headers: { Range: "bytes=0-15" }, signal: AbortSignal.timeout(15_000) });
            let body = "";
            if (ERR_STATUSES.includes(r.status)) { try { body = await r.text(); } catch { /* corpo vazio/consumido */ } }
            return { r, body };
          };

          let { r: res, body: bodyText } = await fetchDriveWithBody();
          let googleRateLimited = res.status === 429 || DRIVE_RATELIMIT_RE.test(bodyText);
          // Retry: (a) arquivo grande engasga no 1º hit (401/403/404 → OK no 2º); (b) rate-limit do
          // Google → espera e re-tenta com backoff maior (a janela anti-abuso passa em segundos).
          // 403 REAL de permissão (arquivo privado) NÃO re-tenta além do 1º hit — não adianta martelar.
          for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
            if (!ERR_STATUSES.includes(res.status)) break;
            if (!googleRateLimited && attempt > 0) break;
            console.log(`[validate-creative] drive check ${res.status}${googleRateLimited ? " (rate-limit Google)" : ""} — retry ${attempt + 1}/${RETRY_BACKOFFS_MS.length} em ${RETRY_BACKOFFS_MS[attempt]}ms`);
            await new Promise((rr) => setTimeout(rr, RETRY_BACKOFFS_MS[attempt]));
            ({ r: res, body: bodyText } = await fetchDriveWithBody());
            googleRateLimited = res.status === 429 || DRIVE_RATELIMIT_RE.test(bodyText);
          }
          const ct = res.headers.get("content-type") || "";
          mark("drive_check", tDrive);
          mark("TOTAL", t0);

          if (ERR_STATUSES.includes(res.status)) {
            const googleDetail = bodyText ? ` [detalhe Google: ${bodyText.replace(/\s+/g, " ").slice(0, 300)}]` : "";
            // Rate-limit anti-abuso do Google — NÃO é arquivo privado. Erro DISTINTO + transiente:
            // o usuário só espera alguns segundos e re-valida (o edge já re-tentou com backoff).
            if (googleRateLimited) {
              console.log(`[validate-creative] drive check ${res.status} = RATE-LIMIT do Google (não é privado): ${bodyText.slice(0, 200)}`);
              return new Response(JSON.stringify({
                ok: false, google_rate_limit: true, transient: true,
                error: `O Google limitou a validação (muitos arquivos de uma vez). Aguarde alguns segundos e clique Validar de novo.${googleDetail}`,
                timings,
              }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            // 401/403/404 acontece tanto por arquivo privado quanto por GOOGLE_DRIVE_API_KEY
            // inválida/restrita (referrer, IP, key revogada). O corpo do erro do Google cita a chave
            // nesse caso — SEMPRE anexamos o corpo bruto (googleDetail) pra não confiar só no regex.
            const looksLikeKeyProblem = /api key|apikey|referer|ip address|key (is )?(invalid|expired|revoked|not valid)|quota|rate limit|accessnotconfigured|not been used in project|has not been used|disabled|blocked/i.test(bodyText);
            if (looksLikeKeyProblem) {
              console.log(`[validate-creative] drive check ${res.status} parece problema na GOOGLE_DRIVE_API_KEY: ${bodyText.slice(0, 300)}`);
              return new Response(JSON.stringify({
                ok: false,
                error: `Não foi possível verificar o arquivo do Drive (erro ${res.status} na chave de API do Google, não no compartilhamento do arquivo). Verifique a configuração de GOOGLE_DRIVE_API_KEY.${googleDetail}`,
                timings,
              }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({
              ok: false,
              error: `Arquivo do Drive não está público (ou outro erro ${res.status} no Google). No Drive: clique no arquivo → Compartilhar → Acesso geral → "Qualquer pessoa com o link" (Leitor) → salve e valide de novo. A publicação baixa por link anônimo, então arquivo privado não funciona. Se o arquivo JÁ está público, o motivo real está aqui:${googleDetail}`,
              timings,
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          if (ct.includes("application/json") || (!res.ok && res.status !== 206)) {
            return new Response(JSON.stringify({
              ok: false, error: `Drive não devolveu o arquivo (status ${res.status}). Confira o link e o compartilhamento.`, timings,
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({
            ok: true, creative_resolved: true, drive_accessible: true,
            media_type: ct.includes("video") ? "video" : ct.includes("image") ? "image" : "unknown", timings,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } catch (e) {
          mark("drive_check", tDrive);
          return new Response(JSON.stringify({
            ok: false, error: `Falha ao verificar arquivo do Drive: ${(e as Error).message}`, timings,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // Sem GOOGLE_DRIVE_API_KEY: fallback antigo (HEAD no uc?export=download).
      // A1/SSRF: EXIGE fileId. Link de ARQUIVO do Drive sempre tem id extraível; link de pasta
      // ou URL arbitrária não tem → rejeita ANTES de qualquer fetch. Com fileId, a URL baixada é
      // SEMPRE a reconstruída (drive.google.com/uc?...), nunca o creative_link cru — é isso que
      // fecha o SSRF (o vetor era o ramo `else downloadUrl = creative_link`).
      if (!fileId) {
        return new Response(JSON.stringify({
          ok: false, error: "Link inválido — use o link do ARQUIVO do Google Drive (não de pasta).", timings,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Defesa extra (host allow-list) — mesmo com fileId, barra creative_link de host estranho.
      const guard = assertSafeDriveUrl(creative_link);
      if (!guard.ok) {
        return new Response(JSON.stringify({ ok: false, error: guard.error, timings }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
      try {
        // redirect:follow — o uc?export=download responde 303 pro drive.usercontent.google.com
        // (allow-listed). fileId obrigatório acima garante que downloadUrl nunca é o link cru.
        const headRes = await fetch(downloadUrl, { method: "HEAD", redirect: "follow" });
        mark("drive_check", tDrive);
        if (!headRes.ok) {
          return new Response(JSON.stringify({
            ok: false, error: "Não foi possível acessar o arquivo do Drive. Deixe o arquivo público.", timings,
          }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const contentType = headRes.headers.get("content-type") || "";
        mark("TOTAL", t0);
        return new Response(JSON.stringify({
          ok: true, creative_resolved: true, drive_accessible: true,
          media_type: contentType.includes("video") ? "video" : contentType.includes("image") ? "image" : "unknown", timings,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch {
        mark("drive_check", tDrive);
        return new Response(JSON.stringify({
          ok: false, error: "Falha ao verificar arquivo do Drive.", timings,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({
      ok: false, error: "Tipo de criativo não reconhecido.", timings,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message, timings }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
