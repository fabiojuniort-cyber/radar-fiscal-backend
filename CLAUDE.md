@AGENTS.md

# Mapa rápido — Anatomia do ato (`src/modules/anatomy`)

Leia este mapa antes de explorar. Detalhes: `docs/anatomy/README.md` (índice) e a skill `anatomia-do-ato`.
Governança/estado: issue tribusca-control#116.

| Tema | Onde |
|---|---|
| Contrato ANAT→TAX v1 | `src/modules/anatomy/contract.ts`, `docs/anatomy/contract-v1.md` + `.schema.json` |
| Motor (offline, puro) | `engine.ts`, `readers.ts` (CONFAZ/DOU/DOE-SP/RFB), `entities.ts` (NCM, faixas, exceções) |
| Preparação de entrada | `dou-preparation.ts`, `json-preparation.ts` (DOE-SP/RFB, provisório) |
| Perfis de regras (ANAT-PROFILE/1) | `profile.ts` (schema/hash), `profile-rules.ts` (compila matchers) |
| Unicode/NFC | `nfc-shadow.ts`, `nfc-recovery.ts`, gerado: `nfc-shadow-table.ts` (via `ops/anatomy/nfc-shadow-table.mjs`) |
| Gold e avaliação | `gold.ts`, `evaluation.ts`, `evaluation-adapter.ts`; gold em `test/fixtures/anatomy/gold/`, specs em `ops/anatomy/gold-specs/` |
| Corpus | `test/fixtures/anatomy/{corpus-manifest.json,canonical,inputs}`; reserva 04,06,08,09,12,14,16,18,24,28 (não ler) |
| Simulação isolada | `rules-simulation.ts`, `simulation-executor.ts`, `simulation-worker.ts` |
| Admin de regras (flag `ANAT_RULES_ADMIN_ENABLED`) | `admin/rules-admin.{service,wiring}.ts`, migrations 077–079 |
| Configuração acessível (flag `ANAT_CONFIG_ENABLED`) | `config/*.ts` (amostras SINTÉTICAS), migration 082 |
| Identidade do build | `build-identity.ts` — gerado por `ops/anatomy/build-identity.mjs --write` |

Testes: `npm run test:anatomy` (unit), `npm run typecheck`. Integração `test/anatomy.*.integration.test.ts` exige PG descartável.
Arquivos gerados nunca são editados à mão.
