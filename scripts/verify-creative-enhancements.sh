#!/usr/bin/env bash
# =============================================================================
#  DIAGNÓSTICO — quais recursos de creative_features_spec a Graph v25.0 ACEITA
#  NA ESCRITA (não só ecoa na leitura).
#
#  Reproduz o passo EXATO que quebrou no PR #86: POST /adcreatives com
#  degrees_of_freedom_spec. Cada probe cria um adcreative de teste PAUSED e o
#  APAGA em seguida. Adcreative avulso NÃO gasta, NÃO vira anúncio, NÃO precisa
#  de campanha/adset — logo é seguro rodar com o token de produção.
#
#  O corpo do POST é idêntico ao real (buildFase1Creative → cr.spec, shape
#  source_instagram_media_id) — a forma mais propensa a recusar os video_*.
#
#  USO:
#    AD_ACCOUNT_ID=act_123456 \
#    ACCESS_TOKEN=EAAxxxxx \
#    IG_MEDIA_ID=17900000000000000 \
#    IG_USER_ID=17800000000000000 \
#      bash scripts/verify-creative-enhancements.sh
#
#    AD_ACCOUNT_ID → act_<id> da conta de anúncios (com o prefixo act_)
#    ACCESS_TOKEN  → o MESMO token que o usuário usa para publicar
#    IG_MEDIA_ID   → source_instagram_media_id de um REEL/VÍDEO real (⚠️ NÃO imagem).
#                    video_auto_crop/video_uncrop são recursos de VÍDEO — numa imagem
#                    podem dar [RECUSADO] FALSO e você removeria um recurso válido.
#                    Reel/vídeo também dá boa confiança para a FASE 2 (vídeo re-upload).
#    IG_USER_ID    → instagram_user_id (o ig actor da conexão)
#
#  COBERTURA: testa a shape source_instagram_media_id (FASE 1/3 — a que QUEBROU).
#  NÃO testa a shape object_story_spec + video_id da FASE 2 (vídeo re-upload do Drive).
#  Se a FASE 2 estiver em uso, confirme à parte com 1 publicação FASE 2 PAUSED real.
#
#  LEITURA DO RESULTADO:
#    [ACEITO]   → a v25.0 aceita esse recurso na escrita  → pode ficar na lista
#    [RECUSADO] → a v25.0 recusa                          → REMOVER de CREATIVE_FEATURES
#    baseline DEVE dar [ACEITO]; standard_enhancements DEVE dar [RECUSADO].
#    Se o baseline falhar, seus IDs de entrada estão errados (não é enhancement).
#
#  REGRA: só faça o deploy do edge com CREATIVE_FEATURES = os recursos [ACEITO].
# =============================================================================
set -euo pipefail

: "${AD_ACCOUNT_ID:?defina AD_ACCOUNT_ID=act_...}"
: "${ACCESS_TOKEN:?defina ACCESS_TOKEN=...}"
: "${IG_MEDIA_ID:?defina IG_MEDIA_ID=...}"
: "${IG_USER_ID:?defina IG_USER_ID=...}"

python3 - <<'PY'
import os, json, urllib.request, urllib.error, urllib.parse

API   = "https://graph.facebook.com/v25.0"
acct  = os.environ["AD_ACCOUNT_ID"]
tok   = os.environ["ACCESS_TOKEN"]
media = os.environ["IG_MEDIA_ID"]
iguser= os.environ["IG_USER_ID"]
LINK  = "https://www.instagram.com/"

def post(url, payload):
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(url, data=data,
                                  headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"error": {"message": e.read().decode()[:300]}}

def delete(cid):
    req = urllib.request.Request(f"{API}/{cid}?access_token={urllib.parse.quote(tok)}", method="DELETE")
    try:
        urllib.request.urlopen(req).read()
    except Exception:
        pass

def probe(label, features):
    spec = {
        "name": f"DIAG enh — {label}",
        "source_instagram_media_id": media,
        "instagram_user_id": iguser,
        "call_to_action": {"type": "VIEW_INSTAGRAM_PROFILE", "value": {"link": LINK}},
        "access_token": tok,
    }
    if features:
        spec["degrees_of_freedom_spec"] = {
            "creative_features_spec": {k: {"enroll_status": "OPT_IN"} for k in features}
        }
    res = post(f"{API}/{acct}/adcreatives", spec)
    if "id" in res:
        print(f"  [ACEITO]    {label}  (creative {res['id']}) — apagando")
        delete(res["id"])
        return True
    err = res.get("error", {})
    msg = err.get("error_user_msg") or err.get("message") or str(res)
    print(f"  [RECUSADO]  {label}  — {msg} [code {err.get('code')}/{err.get('error_subcode')}]")
    return False

print("== creative_features_spec — teste de ESCRITA v25.0 (adcreative avulso, PAUSED, sem gasto) ==")
print(f"   conta={acct}  media={media}  ig_user={iguser}\n")
probe("baseline (sem enhancements)",                 [])
probe("standard_enhancements  (DEPRECATED, DEVE recusar)", ["standard_enhancements"])
probe("text_optimizations",                          ["text_optimizations"])
probe("video_auto_crop",                             ["video_auto_crop"])
probe("video_uncrop",                                ["video_uncrop"])
probe("os 3 juntos (lista atual do edge)",           ["text_optimizations", "video_auto_crop", "video_uncrop"])
print("\n== Mantenha em CREATIVE_FEATURES SÓ os [ACEITO]. Remova [RECUSADO] ANTES do deploy. ==")
PY
