---
name: anatomia-do-ato
description: Convenções e invariantes da frente "Anatomia do ato" (módulo src/modules/anatomy no radar-fiscal-backend e telas /admin/anatomia no radar-fiscal-web). Use ao mexer no motor, leitores, entidades/NCM, perfis de regras, NFC/Unicode, gold/avaliação, simulação, admin de regras ou configuração acessível.
---

# Anatomia do ato

Mapa de arquivos: `CLAUDE.md` do backend. Índice técnico: `docs/anatomy/README.md` — abra só o doc do tema
(`engine.md`, `readers.md`, `entities.md`, `profile*.md`, `unicode*.md`, `nfc-shadow.md`, `GOLD-*.md`, `evaluation.md`,
`rules-simulation.md`, `ADMIN-01*.md`, `CONFIG-01.md`). Estado, gates e decisões: issue tribusca-control#116.

## Invariantes (não quebrar)
- **Motor puro e offline**: `analyze` só lê bytes fornecidos; sem persistência, HTTP, classificação ou detector NCM de produção.
- **Estrutura ≠ natureza ≠ vigência**: natureza deriva do tipo de parte; vigência é `legalStatus` do motor. Cor/estilo/nota nunca provam "vigente".
- **Gold é humano**: nunca derivar gold de saída do motor; specs em `ops/anatomy/gold-specs/`, build por `ops/anatomy/gold-build.ts`. Mudar anotação invalida a aprovação (hash).
- **Reserva intocável**: entradas 04,06,08,09,12,14,16,18,24,28 não são lidas nem medidas.
- **`null` = N/A** na avaliação; nunca substituir por 0/1. Seleções positivas são entrada explícita, nunca inferidas.
- **Perfis são dados, não código**: literais sempre regex-escapados; gramática e proteções de domínio fixas em `profile-rules.ts`.
- **Spans em UTF-16** sobre o texto canônico; recuperação NFC só via `readAnatomyInput`.
- **Amostras da configuração são SINTÉTICAS** (`config/sample-inputs.ts`); não copiar texto oficial/corpus/gold.
- **Arquivos gerados** (`build-identity.ts`, `nfc-shadow-table.ts`, snapshots de equivalência): regenerar pelo script, não editar. Mudança no motor → `node ops/anatomy/build-identity.mjs --write`.
- **Flags off por padrão**: backend `ANAT_RULES_ADMIN_ENABLED`, `ANAT_CONFIG_ENABLED`; web `VITE_ENABLE_ANAT_RULES_ADMIN`, `VITE_ENABLE_ANAT_CONFIG`.
- **Banco**: escrita só pelas entry points SQL auditadas (077–079, 082); sem DML direto, sem migration automática, sem Railway/produção sem autorização.
- **Configuração**: "Salvar" valida e aplica numa ação; o teste vale só para a versão-base em vigor (re-testar se mudou).

## Fluxo de trabalho econômico
1. Leia a issue/pedido e só o doc do tema; use `grep -n` antes de abrir arquivos grandes (`readers.ts`, `contract.ts`, `admin/rules-admin.service.ts`).
2. Teste focado: `npx tsx --test test/anatomy.<tema>.unit.test.ts`; antes do push: `npm run test:anatomy && npm run typecheck`.
3. Web: `src/anatomy-config*.tsx`, `src/anatomy-rules-*.tsx`; `npx vitest run src/anatomy-config.test.tsx`; e2e em `e2e/anatomy-*.spec.ts`.
4. PR draft (CI `DRAFT_FAST_ONLY` é esperado — não rerodar); mudança de contrato/operação exige doc em `docs/anatomy/` no mesmo PR; evidências na issue #116.
