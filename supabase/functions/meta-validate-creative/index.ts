import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
        let mediaUrl: string | null = `https://graph.facebook.com/v22.0/${ig_account_id}/media?fields=id,shortcode,permalink&limit=30&access_token=${access_token}`;
        let mediaApiCalls = 0;
        let mediaChecked = 0;

        while (mediaUrl && mediaChecked < 200) {
          mediaApiCalls++;
          const mediaRes = await fetch(mediaUrl);
          const mediaData = await mediaRes.json();

          if (mediaData.error) {
            console.log(`[validate-creative] FAST PATH media error: ${mediaData.error.message}`);
            // Fall through to page scan
            break;
          }

          if (mediaData.data) {
            mediaChecked += mediaData.data.length;
            const found = mediaData.data.find((m: any) => m.shortcode === shortcode || m.permalink?.includes(shortcode));
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
        console.log(`[validate-creative] FAST PATH: not found after ${mediaApiCalls} calls, ${mediaChecked} items checked. Falling back to page scan.`);
      }

      // === SLOW PATH: Scan pages (only if fast path failed or no ig_account_id) ===
      const tPages = Date.now();
      const allPages: any[] = [];
      let pagesUrl: string | null = `https://graph.facebook.com/v22.0/me/accounts?fields=id,name,instagram_business_account{id}&limit=25&access_token=${access_token}`;
      let pageRequests = 0;
      while (pagesUrl) {
        pageRequests++;
        const pagesRes = await fetch(pagesUrl);
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
        let mediaUrl: string | null = `https://graph.facebook.com/v22.0/${igAccountId}/media?fields=id,shortcode,permalink&limit=30&access_token=${access_token}`;
        let mediaChecked = 0;
        while (mediaUrl && mediaChecked < 200) {
          mediaApiCalls++;
          const mediaRes = await fetch(mediaUrl);
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
      let downloadUrl = creative_link;
      const fileIdMatch = creative_link.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (fileIdMatch) {
        downloadUrl = `https://drive.google.com/uc?export=download&id=${fileIdMatch[1]}`;
      }

      try {
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
