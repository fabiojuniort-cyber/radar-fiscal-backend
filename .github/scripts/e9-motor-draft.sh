#!/usr/bin/env bash
set -euo pipefail

# The pinned source tree and only the authorized E9 inputs are materialized for the old engine.
# GitHub Actions supplies Node, npm dependencies and a read-only checkout.
proof=ops/anatomy/e9-acervo/motor-r2
workspace=$(pwd -P)
temp=$(mktemp -d)
trap 'rm -rf -- "$temp"' EXIT
mkdir "$temp/base" "$temp/proof"

base=$(node -p "require('./$proof/inputs.json').base")
git fetch --no-tags --depth=1 origin "$base"

node --input-type=module - "$proof/inputs.json" > "$temp/paths" <<'NODE'
import { readFileSync } from 'node:fs';

const evidence = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const name of new Set(evidence.samples.flatMap(({path, meta}) => [path, meta]))) {
  if (!/^ops\/anatomy\/official-identification\/(?:rfb-normasinternet2(?:-coleta02)?|rfb-p2c|doesp-ricms|leg-normas|manual|e9-http)\/[A-Za-z0-9_.-]+$/u.test(name)
      || name.endsWith('/.') || name.endsWith('/..')) {
    throw new Error('Path outside E9 evidence');
  }
  console.log(name);
}
NODE
mapfile -t paths < "$temp/paths"
git archive "$base" -- \
  package.json package-lock.json tsconfig.json src \
  ops/anatomy/charset-policy.ts ops/anatomy/fetch-official-core.ts \
  ops/anatomy/official-act-size.ts ops/anatomy/official-coverage-matrix.ts \
  ops/anatomy/official-http-ingest.ts ops/anatomy/official-lot-rfb.ts \
  ops/anatomy/official-manual-ingest.ts ops/anatomy/pdf-text.ts \
  ops/anatomy/reserved-act-keys.ts ops/anatomy/zip-read.ts \
  docs/anatomy/e9-acceptances.json "${paths[@]}" | tar -x -C "$temp/base"
ln -s "$workspace/node_modules" "$temp/base/node_modules"

node --import tsx "$proof/equivalence.mts" "$temp/base" "$workspace" "$temp/proof"
cmp "$temp/proof/equivalence.json" "$proof/equivalence.json"
cmp "$temp/proof/revalidation-proposal.json" "$proof/revalidation-proposal.json"
