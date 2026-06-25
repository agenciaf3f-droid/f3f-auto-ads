import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface PhoneNumber {
  id: string;
  display: string;
  phone: string;
  page_id: string;
  page_name: string;
  status?: string;
  waba_id: string;
}

const timedFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

async function fetchPhoneNumbersFromWaba(wabaId: string, wabaName: string, accessToken: string, pageId: string): Promise<PhoneNumber[]> {
  const nums: PhoneNumber[] = [];
  const res = await timedFetch(
    `https://graph.facebook.com/v25.0/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status&limit=50&access_token=${accessToken}`
  );
  const data = await res.json();
  console.log(`[whatsapp] WABA ${wabaId} phone_numbers:`, JSON.stringify(data));
  if (data.data) {
    for (const num of data.data) {
      nums.push({
        id: num.id,
        display: `${num.display_phone_number}${num.verified_name ? ` (${num.verified_name})` : ""}`,
        phone: num.display_phone_number,
        page_id: pageId || "",
        page_name: wabaName || "",
        status: num.code_verification_status || "unknown",
        waba_id: wabaId,
      });
    }
  }
  return nums;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id, page_id } = await req.json();
    console.log(`[whatsapp] Request: ad_account_id=${ad_account_id}, page_id=${page_id}`);

    if (!access_token) {
      return new Response(JSON.stringify({ ok: false, error: "access_token required", numbers: [] }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const numbers: PhoneNumber[] = [];
    const seenPhones = new Set<string>();

    // Dedupe por NÚMERO (não por id): o mesmo número pode estar em várias WABAs
    // com phone_number_id diferente. Usuário quer 1 entrada por número.
    const addUnique = (nums: PhoneNumber[]) => {
      for (const n of nums) {
        const key = (n.phone || n.id || "").replace(/\D/g, "") || n.id;
        if (!seenPhones.has(key)) {
          seenPhones.add(key);
          numbers.push(n);
        }
      }
    };

    // === STRATEGY 1: Page → whatsapp_business_account → phone_numbers ===
    if (page_id) {
      console.log(`[whatsapp] Strategy 1: Page ${page_id} → whatsapp_business_account`);
      try {
        const res = await timedFetch(
          `https://graph.facebook.com/v25.0/${page_id}?fields=whatsapp_business_account{id,name}&access_token=${access_token}`
        );
        const data = await res.json();
        console.log(`[whatsapp] Strategy 1 response:`, JSON.stringify(data));
        if (data.whatsapp_business_account?.id) {
          const waba = data.whatsapp_business_account;
          const nums = await fetchPhoneNumbersFromWaba(waba.id, waba.name || "", access_token, page_id);
          addUnique(nums);
          console.log(`[whatsapp] Strategy 1 found ${nums.length} numbers`);
        } else {
          console.log(`[whatsapp] Strategy 1: no whatsapp_business_account on page. Error: ${data.error?.message || "none"}`);
        }
      } catch (e) {
        console.log(`[whatsapp] Strategy 1 error: ${e.message}`);
      }
    }

    // === STRATEGY 2: Ad Account → Business → owned_whatsapp_business_accounts ===
    if (numbers.length === 0 && ad_account_id) {
      console.log(`[whatsapp] Strategy 2: Ad Account → Business → owned WABAs`);
      try {
        const bizRes = await timedFetch(
          `https://graph.facebook.com/v25.0/${ad_account_id}?fields=business{id,name}&access_token=${access_token}`
        );
        const bizData = await bizRes.json();
        console.log(`[whatsapp] Strategy 2 business:`, JSON.stringify(bizData));

        if (bizData.business?.id) {
          const businessId = bizData.business.id;

          // Try owned WABAs
          const ownedRes = await timedFetch(
            `https://graph.facebook.com/v25.0/${businessId}/owned_whatsapp_business_accounts?fields=id,name&limit=50&access_token=${access_token}`
          );
          const ownedData = await ownedRes.json();
          console.log(`[whatsapp] Strategy 2 owned WABAs:`, JSON.stringify(ownedData));

          if (ownedData.data?.length) {
            const results = await Promise.allSettled(
              ownedData.data.map((waba: { id: string; name?: string }) =>
                fetchPhoneNumbersFromWaba(waba.id, waba.name || "", access_token, page_id || "")
              )
            );
            results.forEach((r) => {
              if (r.status === "fulfilled") addUnique(r.value);
              else console.log(`[whatsapp] Strategy 2 (owned) WABA fetch failed: ${r.reason?.message || r.reason}`);
            });
            console.log(`[whatsapp] Strategy 2 (owned) found ${numbers.length} numbers`);
          }

          // Try client WABAs if still empty
          if (numbers.length === 0) {
            const clientRes = await timedFetch(
              `https://graph.facebook.com/v25.0/${businessId}/client_whatsapp_business_accounts?fields=id,name&limit=50&access_token=${access_token}`
            );
            const clientData = await clientRes.json();
            console.log(`[whatsapp] Strategy 2 client WABAs:`, JSON.stringify(clientData));

            if (clientData.data?.length) {
              const results = await Promise.allSettled(
                clientData.data.map((waba: { id: string; name?: string }) =>
                  fetchPhoneNumbersFromWaba(waba.id, waba.name || "", access_token, page_id || "")
                )
              );
              results.forEach((r) => {
                if (r.status === "fulfilled") addUnique(r.value);
                else console.log(`[whatsapp] Strategy 2 (client) WABA fetch failed: ${r.reason?.message || r.reason}`);
              });
              console.log(`[whatsapp] Strategy 2 (client) found ${numbers.length} numbers`);
            }
          }
        }
      } catch (e) {
        console.log(`[whatsapp] Strategy 2 error: ${e.message}`);
      }
    }

    // === STRATEGY 3: descoberta ampla de páginas → whatsapp_business_account ===
    // Espelha a cobertura do meta-ad-accounts (owner_business + promote_pages +
    // /me/accounts paginado). Necessário p/ contas SEM business (Strategy 2 morre)
    // cujo WABA só é alcançável via página.
    if (numbers.length === 0) {
      console.log(`[whatsapp] Strategy 3: descoberta ampla de páginas`);
      const candidatePages: { id: string; name?: string; waba?: { id: string; name?: string } }[] = [];
      const seenPageIds = new Set<string>();
      const addPages = (arr: any[]) => {
        for (const p of arr || []) {
          if (p?.id && !seenPageIds.has(p.id)) {
            seenPageIds.add(p.id);
            candidatePages.push({ id: p.id, name: p.name, waba: p.whatsapp_business_account });
          }
        }
      };

      // 3a: pages do BM dono da ad account (owned + client)
      if (ad_account_id) {
        try {
          const aaRes = await timedFetch(
            `https://graph.facebook.com/v25.0/${ad_account_id}?fields=owner_business{owned_pages.limit(200){id,name,whatsapp_business_account{id,name}},client_pages.limit(200){id,name,whatsapp_business_account{id,name}}}&access_token=${access_token}`
          );
          const aaData = await aaRes.json();
          addPages(aaData?.owner_business?.owned_pages?.data);
          addPages(aaData?.owner_business?.client_pages?.data);
        } catch (e) {
          console.log(`[whatsapp] 3a owner_business error: ${e.message}`);
        }
        // 3b: promote_pages — pages que essa ad account pode anunciar
        try {
          const ppRes = await timedFetch(
            `https://graph.facebook.com/v25.0/${ad_account_id}/promote_pages?fields=id,name,whatsapp_business_account{id,name}&limit=100&access_token=${access_token}`
          );
          const ppData = await ppRes.json();
          addPages(ppData?.data);
        } catch (e) {
          console.log(`[whatsapp] 3b promote_pages error: ${e.message}`);
        }
      }

      // 3c: /me/accounts (paginado)
      try {
        let pagesUrl: string | null = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,whatsapp_business_account{id,name}&limit=100&access_token=${access_token}`;
        let guard = 0;
        while (pagesUrl && guard < 10) {
          const r = await timedFetch(pagesUrl);
          const d = await r.json();
          addPages(d?.data);
          pagesUrl = d?.paging?.next || null;
          guard++;
        }
      } catch (e) {
        console.log(`[whatsapp] 3c me/accounts error: ${e.message}`);
      }

      const pagesWithWaba = candidatePages.filter((p) => p.waba?.id);
      console.log(`[whatsapp] Strategy 3: ${candidatePages.length} páginas, ${pagesWithWaba.length} com WABA`);
      for (const p of pagesWithWaba) {
        console.log(`[whatsapp] Strategy 3: page ${p.id} (${p.name}) → WABA ${p.waba!.id}`);
      }
      const results = await Promise.allSettled(
        pagesWithWaba.map((p) => fetchPhoneNumbersFromWaba(p.waba!.id, p.waba!.name || p.name || "", access_token, p.id))
      );
      results.forEach((r) => {
        if (r.status === "fulfilled") addUnique(r.value);
        else console.log(`[whatsapp] Strategy 3 WABA fetch failed: ${r.reason?.message || r.reason}`);
      });
      console.log(`[whatsapp] Strategy 3 found ${numbers.length} numbers`);
    }

    console.log(`[whatsapp] Final total: ${numbers.length} numbers`);
    return new Response(JSON.stringify({ ok: true, numbers }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.log(`[whatsapp] Fatal error: ${e.message}`);
    return new Response(JSON.stringify({ ok: false, error: e.message, numbers: [] }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
