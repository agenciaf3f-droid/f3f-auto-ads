import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { access_token, action } = body;

    // Action: get_pages — returns pages with instagram_business_account
    if (action === "get_pages") {
      const allPages: any[] = [];
      let url: string | null = `https://graph.facebook.com/v22.0/me/accounts?fields=id,name,instagram_business_account{id}&limit=25&access_token=${access_token}`;
      while (url) {
        const pagesRes = await fetch(url);
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
      // Step 1: Get IG accounts authorized for this ad account
      const igRes = await fetch(
        `https://graph.facebook.com/v22.0/${ad_account_id}/instagram_accounts?fields=id,username&limit=25&access_token=${access_token}`
      );
      const igData = await igRes.json();
      if (igData.error) {
        return new Response(JSON.stringify({ error: igData.error.message }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const igAccounts = (igData.data || []).map((ig: any) => ({
        id: ig.id,
        username: ig.username || null,
      }));

      // Step 2: Get ALL pages (with full pagination) to find which page owns each IG account
      const allPages: any[] = [];
      let pagesUrl: string | null = `https://graph.facebook.com/v22.0/me/accounts?fields=id,name,instagram_business_account{id},whatsapp_business_account{id,name}&limit=25&access_token=${access_token}`;
      while (pagesUrl) {
        const pagesRes = await fetch(pagesUrl);
        const pagesData = await pagesRes.json();
        if (pagesData.data) allPages.push(...pagesData.data);
        pagesUrl = pagesData.paging?.next || null;
        if (allPages.length >= 300) break; // Safety limit
      }

      // Match IG accounts to pages
      const results: any[] = [];
      for (const ig of igAccounts) {
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
            const phoneRes = await fetch(
              `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers?fields=id,display_phone_number&limit=1&access_token=${access_token}`
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
      }

      return new Response(JSON.stringify({ ig_accounts: results, pages_scanned: allPages.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Default action: list ad accounts
    const allAccounts: { id: string; name: string }[] = [];

    let url: string | null = `https://graph.facebook.com/v22.0/me/adaccounts?fields=id,name&limit=50&access_token=${access_token}`;

    while (url) {
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        return new Response(JSON.stringify({ error: data.error.message }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (data.data) {
        for (const acc of data.data) {
          allAccounts.push({ id: acc.id, name: acc.name || acc.id });
        }
      }

      url = data.paging?.next || null;
    }

    return new Response(JSON.stringify({ accounts: allAccounts }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
