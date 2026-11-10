#!/usr/bin/env bash
# ANAT-CONFIG-01: post-deploy checks with every ANAT flag off. Read-only: GET requests without credentials.
#   bash ops/anatomy/config-postdeploy-check.sh [backend-url] [site-url]
# Expected: all lines PASS. Prints FAIL and exits 1 otherwise.
set -u
API="${1:-https://radar-fiscal-backend-production.up.railway.app}"
SITE="${2:-https://www.trifaros.com.br}"
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS $1 (=$3)"; else echo "FAIL $1: esperado $2, obtido $3"; fail=1; fi
}
code() { curl -sS -o /dev/null -m 20 -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

health_body="$(curl -sS -m 20 "$API/health" 2>/dev/null || true)"
check "health HTTP" 200 "$(code "$API/health")"
case "$health_body" in *'"database":"up"'*) echo "PASS health database up";; *) echo "FAIL health database: $health_body"; fail=1;; esac
check "anatomy-config sem token (flag desligada)" 404 "$(code "$API/api/v1/admin/anatomy-config")"
check "anatomy-rules antiga sem token (flag desligada)" 404 "$(code "$API/api/v1/admin/anatomy-rules/drafts")"
check "admin/me sem token" 401 "$(code "$API/api/v1/admin/me")"
check "site" 200 "$(code "$SITE/")"
echo "MANUAL: abrir $SITE/admin/anatomia no navegador: deve voltar para a página inicial, e o menu admin não mostra 'Anatomia dos atos'."
exit $fail
