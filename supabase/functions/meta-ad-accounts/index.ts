import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const timedFetch = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { access_token, action } = body;

    // Action: get_pages — returns pages with instagram_business_account
    if (action === "get_pages") {
      const allPages: any[] = [];
      let url: string | null = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,instagram_business_account{id}&limit=25&access_token=${access_token}`;
      while (url) {
        const pagesRes = await timedFetch(url);
        const pagesData = await pagesRes.json();
        if (pagesData.error) {
          return new Response(JSON.stringify({ error: pagesData.error.message }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (pagesData.data) allPages.push(...pagesData.data);
        url = pagesData.paging?.next || null;
        // Safety: stop after 200 pages
        if (allPages.length >= 200) break;
      }
      return new Response(JSON.stringify({ pages: allPages }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Action: get_ig_accounts — returns Instagram accounts authorized for a specific ad account
    if (action === "get_ig_accounts") {
      const { ad_account_id } = body;
      if (!ad_account_id) {
        return new Response(JSON.stringify({ error: "ad_account_id é obrigatório" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Diagnóstico: armazena tentativas pra surfar motivo se 0 IG
      const diagnostic: { endpoint: string; status: string; detail?: string; count?: number }[] = [];

      // Step 1a: Get IG accounts authorized for this ad account
      const igRes = await timedFetch(
        `https://graph.facebook.com/v25.0/${ad_account_id}/instagram_accounts?fields=id,username&limit=25&access_token=${access_token}`
      );
      const igData = await igRes.json();
      let igAccounts: { id: string; username: string | null }[] = [];

      if (igData.error) {
        diagnostic.push({ endpoint: "/instagram_accounts", status: "error", detail: `code=${igData.error.code} subcode=${igData.error.error_subcode} | ${igData.error.message}` });
      } else {
        igAccounts = (igData.data || []).map((ig: any) => ({
          id: ig.id,
          username: ig.username || null,
        }));
        diagnostic.push({ endpoint: "/instagram_accounts", status: "ok", count: igAccounts.length });
      }

      // Step 1b: Fallback — /{ad_account_id}/connected_instagram_accounts
      if (igAccounts.length === 0) {
        try {
          const ciaRes = await timedFetch(
            `https://graph.facebook.com/v25.0/${ad_account_id}/connected_instagram_accounts?fields=id,username&limit=25&access_token=${access_token}`
          );
          const ciaData = await ciaRes.json();
          if (ciaData.error) {
            diagnostic.push({ endpoint: "/connected_instagram_accounts", status: "error", detail: `code=${ciaData.error.code} | ${ciaData.error.message}` });
          } else if (ciaData.data?.length) {
            igAccounts = ciaData.data.map((ig: any) => ({ id: ig.id, username: ig.username || null }));
            diagnostic.push({ endpoint: "/connected_instagram_accounts", status: "ok", count: igAccounts.length });
          } else {
            diagnostic.push({ endpoint: "/connected_instagram_accounts", status: "empty" });
          }
        } catch (e) {
          diagnostic.push({ endpoint: "/connected_instagram_accounts", status: "exception", detail: (e as Error).message });
        }
      }

      // Step 1c: Fallback — buscar IG na própria ad account via /{ad_account_id}?fields=instagram_actor_id
      if (igAccounts.length === 0) {
        try {
          const aaRes = await timedFetch(
            `https://graph.facebook.com/v25.0/${ad_account_id}?fields=instagram_actor_id{username},business&access_token=${access_token}`
          );
          const aaData = await aaRes.json();
          if (aaData.instagram_actor_id) {
            igAccounts = [{ id: aaData.instagram_actor_id.id || aaData.instagram_actor_id, username: aaData.instagram_actor_id?.username || null }];
            diagnostic.push({ endpoint: "/act?instagram_actor_id", status: "ok", count: 1 });
          } else {
            diagnostic.push({ endpoint: "/act?instagram_actor_id", status: "empty", detail: aaData.business?.id ? `business=${aaData.business.id}` : "no_business" });
          }
        } catch (e) {
          diagnostic.push({ endpoint: "/act?instagram_actor_id", status: "exception", detail: (e as Error).message });
        }
      }

      // Varre páginas SEMPRE. Quando os endpoints diretos de IG dão 0, descobrimos
      // o IG via page.instagram_business_account (IG conectado só via Página).
      const allPages: any[] = [];
      {
        // discoverFromPages: não temos IG-alvo; varrer páginas e derivar IG delas.
        const discoverFromPages = igAccounts.length === 0;
        const igIds = new Set(igAccounts.map((ig: any) => ig.id));
        const matchedSoFar = (): number =>
          allPages.filter((p: any) => p.instagram_business_account?.id && igIds.has(p.instagram_business_account.id)).length;
        // Para com varredura quando já casou todos os IG-alvo (irrelevante no modo discover).
        const enough = (): boolean => !discoverFromPages && matchedSoFar() >= igAccounts.length;
        const haveIgPage = (): boolean => allPages.some((p: any) => p.instagram_business_account?.id);
        // No modo discover: assim que uma fonte escopada na ad account (owner_business /
        // promote_pages) já trouxe uma página com IG, não precisa varrer /me/accounts global.
        const stop = (): boolean => enough() || (discoverFromPages && haveIgPage());

        // Step 2a: pages do BM dono da ad account (cobre o caso onde user não é admin direto da Page)
        try {
          const aaRes = await timedFetch(
            `https://graph.facebook.com/v25.0/${ad_account_id}?fields=owner_business{owned_pages.limit(200){id,name,instagram_business_account{id,username},whatsapp_business_account{id,name}},client_pages.limit(200){id,name,instagram_business_account{id,username},whatsapp_business_account{id,name}}}&access_token=${access_token}`
          );
          const aaData = await aaRes.json();
          if (aaData.error) {
            diagnostic.push({ endpoint: "/act?owner_business.pages", status: "error", detail: `code=${aaData.error.code} | ${aaData.error.message}` });
          } else {
            const ownedBM: any[] = aaData?.owner_business?.owned_pages?.data || [];
            const clientBM: any[] = aaData?.owner_business?.client_pages?.data || [];
            allPages.push(...ownedBM, ...clientBM);
            diagnostic.push({ endpoint: "/act?owner_business.pages", status: "ok", count: ownedBM.length + clientBM.length });
          }
        } catch (e) {
          diagnostic.push({ endpoint: "/act?owner_business.pages", status: "exception", detail: (e as Error).message });
        }

        // Step 2b: /{ad_account_id}/promote_pages — pages que essa ad account pode anunciar
        if (!stop()) {
          try {
            const ppRes = await timedFetch(
              `https://graph.facebook.com/v25.0/${ad_account_id}/promote_pages?fields=id,name,instagram_business_account{id,username},whatsapp_business_account{id,name}&limit=100&access_token=${access_token}`
            );
            const ppData = await ppRes.json();
            if (ppData.error) {
              diagnostic.push({ endpoint: "/act/promote_pages", status: "error", detail: `code=${ppData.error.code} | ${ppData.error.message}` });
            } else {
              const existingIds = new Set(allPages.map((p: any) => p.id));
              const promote = (ppData.data || []).filter((p: any) => !existingIds.has(p.id));
              allPages.push(...promote);
              diagnostic.push({ endpoint: "/act/promote_pages", status: "ok", count: promote.length });
            }
          } catch (e) {
            diagnostic.push({ endpoint: "/act/promote_pages", status: "exception", detail: (e as Error).message });
          }
        }

        // Step 2c: pages que o user é admin direto (/me/accounts) — só se as fontes
        // escopadas na ad account não resolveram (evita varrer todas as páginas do admin).
        if (!stop()) {
          let pagesUrl: string | null = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,instagram_business_account{id,username},whatsapp_business_account{id,name}&limit=100&access_token=${access_token}`;
          while (pagesUrl) {
            const pagesRes = await timedFetch(pagesUrl);
            const pagesData = await pagesRes.json();
            if (pagesData.data) {
              // dedup por id
              const existingIds = new Set(allPages.map((p: any) => p.id));
              for (const p of pagesData.data) {
                if (!existingIds.has(p.id)) allPages.push(p);
              }
            }
            pagesUrl = pagesData.paging?.next || null;
            if (allPages.length >= 800) break;
            if (stop()) break;
          }
        }

        // Se não tínhamos IG-alvo, deriva IG accounts das páginas varridas.
        if (discoverFromPages) {
          const seen = new Set<string>();
          for (const p of allPages) {
            const iba = p.instagram_business_account;
            if (iba?.id && !seen.has(iba.id)) {
              seen.add(iba.id);
              igAccounts.push({ id: iba.id, username: iba.username || null });
            }
          }
          diagnostic.push({ endpoint: "_ig_from_pages", status: igAccounts.length ? "ok" : "empty", count: igAccounts.length });
        }
      }

      // Match IG accounts to pages
      const results: any[] = [];
      await Promise.all(igAccounts.map(async (ig) => {
        let matchedPage: any = null;
        for (const page of allPages) {
          if (page.instagram_business_account?.id === ig.id) {
            matchedPage = page;
            break;
          }
        }
        // If page has a WABA, fetch phone numbers
        let wabaPhoneId: string | null = null;
        let wabaPhone: string | null = null;
        if (matchedPage?.whatsapp_business_account?.id) {
          try {
            const wabaId = matchedPage.whatsapp_business_account.id;
            const phoneRes = await timedFetch(
              `https://graph.facebook.com/v25.0/${wabaId}/phone_numbers?fields=id,display_phone_number&limit=1&access_token=${access_token}`
            );
            const phoneData = await phoneRes.json();
            if (phoneData.data?.length) {
              wabaPhoneId = phoneData.data[0].id;
              wabaPhone = phoneData.data[0].display_phone_number || null;
            }
          } catch (e) {
            console.log(`[ad-accounts] Error fetching WABA phone for page ${matchedPage.id}: ${e.message}`);
          }
        }
        results.push({
          ig_account_id: ig.id,
          ig_username: ig.username,
          page_id: matchedPage?.id || null,
          page_name: matchedPage?.name || null,
          waba_phone_id: wabaPhoneId,
          waba_phone: wabaPhone,
        });
      }));

      // Adiciona contador final de pages no diagnóstico
      diagnostic.push({ endpoint: "_total_pages_scanned", status: "info", count: allPages.length });

      return new Response(JSON.stringify({ ig_accounts: results, pages_scanned: allPages.length, diagnostic }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Default action: list ad accounts (direct + Business Manager owned + client)
    const accountMap = new Map<string, { id: string; name: string }>();

    const paginate = async (initialUrl: string) => {
      let url: string | null = initialUrl;
      while (url) {
        const res = await timedFetch(url);
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        if (data.data) {
          for (const acc of data.data) {
            if (!accountMap.has(acc.id)) {
              accountMap.set(acc.id, { id: acc.id, name: acc.name || acc.id });
            }
          }
        }
        url = data.paging?.next || null;
      }
    };

    // 1) Contas onde user é admin direto
    await paginate(`https://graph.facebook.com/v25.0/me/adaccounts?fields=id,name&limit=50&access_token=${access_token}`);

    // 2) Contas via Business Manager (owned + client) — best-effort, em paralelo
    let businesses: any[] = [];
    let bizError: string | null = null;
    try {
      const bizRes = await timedFetch(`https://graph.facebook.com/v25.0/me/businesses?fields=id,name&limit=50&access_token=${access_token}`);
      const bizData = await bizRes.json();
      if (bizData.error) {
        bizError = bizData.error.message;
      } else {
        businesses = bizData.data || [];
      }
    } catch (e) {
      bizError = (e as Error).message;
    }

    // Paraleliza varredura dos BMs com timeout individual
    const bizTasks = businesses.flatMap((biz) => [
      paginate(`https://graph.facebook.com/v25.0/${biz.id}/owned_ad_accounts?fields=id,name&limit=50&access_token=${access_token}`)
        .catch((e) => console.log(`[ad-accounts] owned ${biz.id}: ${(e as Error).message}`)),
      paginate(`https://graph.facebook.com/v25.0/${biz.id}/client_ad_accounts?fields=id,name&limit=50&access_token=${access_token}`)
        .catch((e) => console.log(`[ad-accounts] client ${biz.id}: ${(e as Error).message}`)),
    ]);
    await Promise.all(bizTasks);

    const allAccounts = Array.from(accountMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    return new Response(JSON.stringify({ accounts: allAccounts, businesses_scanned: businesses.length, biz_error: bizError }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
