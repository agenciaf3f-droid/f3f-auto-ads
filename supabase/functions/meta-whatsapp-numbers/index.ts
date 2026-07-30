import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cacheDiscovery } from "../_shared/discovery-cache.ts";

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

// Segue paging.next até esgotar (guard de 10 páginas). Mesmo padrão do
// meta-ad-accounts; aqui local porque a edge é auto-contida.
async function fetchAllPages<T>(firstUrl: string): Promise<{ data: T[]; error: string | null }> {
  const out: T[] = [];
  let url: string | null = firstUrl;
  let guard = 0;
  while (url && guard < 10) {
    const res = await timedFetch(url);
    const data = await res.json();
    if (data.error) return { data: out, error: String(data.error.message || "erro Graph") };
    if (Array.isArray(data.data)) out.push(...data.data);
    url = data.paging?.next || null;
    guard++;
  }
  return { data: out, error: null };
}

async function fetchPhoneNumbersFromWaba(
  wabaId: string,
  sourceName: string,
  accessToken: string,
  pageId: string,
  pageName?: string,
): Promise<{ nums: PhoneNumber[]; error: string | null }> {
  const { data, error } = await fetchAllPages<{
    id: string; display_phone_number?: string; verified_name?: string; code_verification_status?: string;
  }>(
    `https://graph.facebook.com/v25.0/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status&limit=50&access_token=${accessToken}`
  );
  console.log(`[whatsapp] WABA ${wabaId} phone_numbers: ${data.length}${error ? ` err=${error}` : ""}`);
  if (error) return { nums: [], error: `WABA ${wabaId}: ${error}` };
  const nums: PhoneNumber[] = data.map((num) => ({
    id: num.id,
    display: `${num.display_phone_number}${num.verified_name ? ` (${num.verified_name})` : ""}`,
    phone: num.display_phone_number || "",
    // page_id REAL quando a fonte é uma página (S1/promote_pages); "" quando a
    // fonte é a BM (número existe mas não sabemos vínculo com página).
    page_id: pageId || "",
    page_name: pageName || sourceName || "",
    status: num.code_verification_status || "unknown",
    waba_id: wabaId,
  }));
  return { nums, error: null };
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
    const byKey = new Map<string, number>(); // key normalizada → índice em numbers

    // Dedupe por NÚMERO (não por id): o mesmo número pode estar em várias WABAs
    // com phone_number_id diferente. 1 entrada por número; se a duplicata tem
    // page_id REAL e a existente não, a com página vence (o front mostra origem).
    const addUnique = (nums: PhoneNumber[]) => {
      for (const n of nums) {
        const key = (n.phone || n.id || "").replace(/\D/g, "") || n.id;
        const at = byKey.get(key);
        if (at === undefined) {
          byKey.set(key, numbers.length);
          numbers.push(n);
        } else if (n.page_id && !numbers[at].page_id) {
          numbers[at] = n;
        }
      }
    };

    // Diagnóstico p/ explicar falha (sem entrada manual: precisamos do motivo real).
    const notes: string[] = [];
    // WABAs descobertas por ID (Set: a mesma WABA aparece em várias fontes na união)
    const seenWabas = new Set<string>();
    const countWaba = (id: string) => { if (id) seenWabas.add(id); };
    let scopeIssue = false;
    // Só sinais REAIS de scope/permissão. Âncora (?!\d) evita que #10 case dentro de #100
    // (#100 = campo inexistente, NÃO é permissão — era a causa do falso "reconecte scope").
    const looksScope = (msg?: string | null) =>
      !!msg && /whatsapp_business_management|permission|missing|#200(?!\d)|#10(?!\d)|OAuthException/i.test(msg);
    const recordWabaError = (err: string | null) => {
      if (err) { notes.push(err); if (looksScope(err)) scopeIssue = true; }
    };

    // Mensagem acionável: distingue "vinculada na BM" de "conectada à Página".
    const PAGE_CONNECT_HINT = `A Página vinculada${page_id ? ` (id ${page_id})` : ""} não tem número de WhatsApp CONECTADO a ela — listando os números da Business Manager da conta. Para conectar um número à Página: Configurações da Página → WhatsApp.`;

    // === FONTE 1: Page → whatsapp_business_account → phone_numbers ===
    // (roda sempre que há page_id; os números daqui têm page_id REAL e ficam no topo)
    if (page_id) {
      try {
        const res = await timedFetch(
          `https://graph.facebook.com/v25.0/${page_id}?fields=name,whatsapp_business_account{id,name}&access_token=${access_token}`
        );
        const data = await res.json();
        console.log(`[whatsapp] Fonte 1 (página):`, JSON.stringify(data));
        if (data.whatsapp_business_account?.id) {
          const waba = data.whatsapp_business_account;
          countWaba(waba.id);
          const { nums, error } = await fetchPhoneNumbersFromWaba(waba.id, waba.name || "", access_token, page_id, data.name);
          recordWabaError(error);
          addUnique(nums);
        } else if (data.error) {
          // #100 "nonexisting field" = página SEM WABA conectada — não é erro de permissão.
          const emsg = String(data.error.message || "");
          if (Number(data.error.code) === 100 && /whatsapp_business_account/i.test(emsg)) {
            notes.push(PAGE_CONNECT_HINT);
          } else {
            recordWabaError(`Página: ${emsg}`);
          }
        } else {
          notes.push(PAGE_CONNECT_HINT);
        }
      } catch (e) {
        console.log(`[whatsapp] Fonte 1 error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // === FONTE 2 (SEMPRE): Ad Account → business/owner_business → owned + client WABAs ===
    // União: todos os números aos quais a BM da conta tem acesso, não só o da página.
    if (ad_account_id) {
      try {
        // business e owner_business em requests SEPARADOS: pedir um campo que não
        // existe no node (#100) derruba o request inteiro e levaria o outro junto.
        const businessIds = new Map<string, string>(); // id → name
        let bizErr: string | null = null;
        for (const field of ["business", "owner_business"] as const) {
          try {
            const res = await timedFetch(
              `https://graph.facebook.com/v25.0/${ad_account_id}?fields=${field}{id,name}&access_token=${access_token}`
            );
            const data = await res.json();
            const biz = data?.[field];
            if (biz?.id) businessIds.set(biz.id, biz.name || "");
            else if (data?.error && Number(data.error.code) !== 100) {
              // #100 = campo inexistente nessa conta — normal, não é erro.
              bizErr = String(data.error.message || "");
            }
          } catch (e) {
            console.log(`[whatsapp] Fonte 2 ${field} error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        console.log(`[whatsapp] Fonte 2 businesses:`, JSON.stringify([...businessIds]));
        if (businessIds.size === 0 && bizErr) {
          recordWabaError(`Conta de anúncios: ${bizErr}`);
        }

        for (const [businessId, businessName] of businessIds) {
          for (const edge of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"] as const) {
            const { data: wabas, error } = await fetchAllPages<{ id: string; name?: string }>(
              `https://graph.facebook.com/v25.0/${businessId}/${edge}?fields=id,name&limit=50&access_token=${access_token}`
            );
            if (error) { recordWabaError(`Business ${edge === "owned_whatsapp_business_accounts" ? "owned" : "client"} WABAs: ${error}`); continue; }
            wabas.forEach((w) => countWaba(w.id));
            const results = await Promise.allSettled(
              wabas.map((waba) =>
                fetchPhoneNumbersFromWaba(waba.id, waba.name || businessName, access_token, "")
              )
            );
            results.forEach((r) => {
              if (r.status === "fulfilled") { recordWabaError(r.value.error); addUnique(r.value.nums); }
              else console.log(`[whatsapp] Fonte 2 WABA fetch failed: ${r.reason?.message || r.reason}`);
            });
          }
        }
        console.log(`[whatsapp] Fonte 2 total acumulado: ${numbers.length}`);
      } catch (e) {
        console.log(`[whatsapp] Fonte 2 error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // === FONTE 3 (SEMPRE): promote_pages → páginas com WABA (traz page_id REAL) ===
    if (ad_account_id) {
      try {
        const { data: pages, error } = await fetchAllPages<{
          id: string; name?: string; whatsapp_business_account?: { id: string; name?: string };
        }>(
          `https://graph.facebook.com/v25.0/${ad_account_id}/promote_pages?fields=id,name,whatsapp_business_account{id,name}&limit=100&access_token=${access_token}`
        );
        if (error) recordWabaError(`promote_pages: ${error}`);
        const pagesWithWaba = pages.filter((p) => p.whatsapp_business_account?.id);
        pagesWithWaba.forEach((p) => countWaba(p.whatsapp_business_account!.id));
        console.log(`[whatsapp] Fonte 3: ${pages.length} páginas, ${pagesWithWaba.length} com WABA`);
        const results = await Promise.allSettled(
          pagesWithWaba.map((p) =>
            fetchPhoneNumbersFromWaba(p.whatsapp_business_account!.id, p.whatsapp_business_account!.name || p.name || "", access_token, p.id, p.name)
          )
        );
        results.forEach((r) => {
          if (r.status === "fulfilled") { recordWabaError(r.value.error); addUnique(r.value.nums); }
          else console.log(`[whatsapp] Fonte 3 WABA fetch failed: ${r.reason?.message || r.reason}`);
        });
      } catch (e) {
        console.log(`[whatsapp] Fonte 3 error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // === FONTE 4 (último recurso, SÓ se união vazia): varredura ampla de páginas ===
    // owner_business pages + /me/accounts limitado (token admin acessa BMs demais —
    // varrer tudo custa caro; por isso continua gateada).
    if (numbers.length === 0) {
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
      const haveWabaPage = () => candidatePages.some((p) => p.waba?.id);

      if (ad_account_id) {
        try {
          const aaRes = await timedFetch(
            `https://graph.facebook.com/v25.0/${ad_account_id}?fields=owner_business{owned_pages.limit(100){id,name,whatsapp_business_account{id,name}},client_pages.limit(100){id,name,whatsapp_business_account{id,name}}}&access_token=${access_token}`
          );
          const aaData = await aaRes.json();
          addPages(aaData?.owner_business?.owned_pages?.data);
          addPages(aaData?.owner_business?.client_pages?.data);
        } catch (e) {
          console.log(`[whatsapp] Fonte 4 owner_business error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!haveWabaPage()) {
        try {
          let pagesUrl: string | null = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,whatsapp_business_account{id,name}&limit=25&access_token=${access_token}`;
          let guard = 0;
          while (pagesUrl && guard < 4) {
            const r = await timedFetch(pagesUrl);
            const d = await r.json();
            addPages(d?.data);
            if (haveWabaPage()) break;
            pagesUrl = d?.paging?.next || null;
            guard++;
          }
        } catch (e) {
          console.log(`[whatsapp] Fonte 4 me/accounts error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const pagesWithWaba = candidatePages.filter((p) => p.waba?.id);
      pagesWithWaba.forEach((p) => countWaba(p.waba!.id));
      const results = await Promise.allSettled(
        pagesWithWaba.map((p) => fetchPhoneNumbersFromWaba(p.waba!.id, p.waba!.name || p.name || "", access_token, p.id, p.name))
      );
      results.forEach((r) => {
        if (r.status === "fulfilled") { recordWabaError(r.value.error); addUnique(r.value.nums); }
        else console.log(`[whatsapp] Fonte 4 WABA fetch failed: ${r.reason?.message || r.reason}`);
      });
      if (candidatePages.length === 0) notes.push("Nenhuma página acessível encontrada pela conexão Meta (admin sem acesso às páginas dessa conta).");
      else if (pagesWithWaba.length === 0) notes.push("Nenhuma das páginas dessa conta tem WhatsApp Business conectado e a BM não tem WABA com número acessível.");
      console.log(`[whatsapp] Fonte 4 found ${numbers.length} numbers`);
    }


    // Sem entrada manual: se vazio, montar motivo claro p/ o gestor.
    let error_summary: string | null = null;
    if (numbers.length === 0) {
      if (scopeIssue) {
        error_summary = "WhatsApp encontrado, mas a conexão Meta da agência não tem permissão para lê-lo. O admin precisa reconectar a conta Meta concedendo a permissão whatsapp_business_management.";
      } else if (seenWabas.size > 0) {
        error_summary = `Encontrei ${seenWabas.size} conta(s) WhatsApp Business, mas nenhuma com número de telefone disponível via API. ${notes[0] || "Verifique se há um número adicionado e verificado no WhatsApp Manager."}`;
      } else {
        error_summary = notes[0] || "Nenhum WhatsApp Business conectado à página/conta. Vincule um WhatsApp no Gerenciador de Negócios da Meta.";
      }
      if (notes.length) error_summary += ` [detalhe: ${notes.slice(0, 3).join(" • ")}]`;
    }

    console.log(`[whatsapp] Final total: ${numbers.length} numbers | summary: ${error_summary || "ok"}`);
    // Guard non-empty: edge sempre retorna 200 ok:true (inclusive vazio c/ error_summary).
    // Sem guard, [] de falha transiente clobbaria cache bom.
    // kind v2: união BM+página — não misturar com o cache antigo (page-scoped).
    if (numbers.length) await cacheDiscovery("whatsapp_numbers_v2", ad_account_id, numbers);
    // Ordenação DEPOIS do cache: números da página do request primeiro (estabiliza o
    // auto-select do front). O cache fica neutro — é por ad_account e serve qualquer página.
    if (page_id) {
      numbers.sort((a, b) => Number(b.page_id === page_id) - Number(a.page_id === page_id));
    }
    return new Response(JSON.stringify({ ok: true, numbers, error_summary, waba_count: seenWabas.size }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.log(`[whatsapp] Fatal error: ${e instanceof Error ? e.message : String(e)}`);
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), numbers: [] }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
