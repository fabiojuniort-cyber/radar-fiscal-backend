# TAX13/B4 — Atuação e prova de vigência por fragmento (versão em revisão)

**Estado:** implementação parcial em PR #186. Sem autorização para deploy/migration/reprocessamento. Governança: `tribusca-control#93`, frente especializada `tribusca-control#97`, revisor `#95`.

## 1. O que foi implementado

- `migrations/044_tax13_legal_scope_attestations.sql`: eventos imutáveis de atestação, associados à versão/à origem, URL oficial, data de referência, verificação/expiração, hash de HTML e JSON do manifesto; RLS obrigatório e gatilhos de identidade/integridade. A migration **não deve** ser aplicada antes de 042/043 (onboarding ainda em PR #190).
- `legal-scope-evidence.ts`: validador de prova por fragmento (offset + SHA-256, método, URLs HTTPS oficiais permitidas, prazo). `CURRENT` sem prova de consolidação ou alteração oficial é recusado. Fragmentos `UNVERIFIED` não produzem afirmações classificáveis.
- `legal-scope.repository.ts`: leitor restrito ao worker, cruza versão corrente e origem, valida hash e dados contra o manifesto. Falha fechada para ausências/contradições.
- `tax13-attest-legal-scope-one.ts`: **ferramenta manual para uma única versão**, com dry-run por padrão, revisão humana identificada e trilha de auditoria. Ela NÃO pesquisa nem interpreta automaticamente leis ou atos alteradores.
- `taxonomy-ncm-rescan-one.ts`: com `--confirm`, precisa encontrar uma atestação válida com ao menos um segmento vigente; sem isso, aborta, não supersede scans NCM antigos.

## 2. Contrato do manifesto

Documento JSON versionado conforme `LegalScopeEvidenceV1`: `publicationVersionId`, `sourceId`, `officialUrl`, `htmlSha256`, `validAsOf` (YYYY-MM-DD), `verifiedAt` (ISO UTC), `recheckOn` (depois da data de referência), `coverage` (`COMPLETE/PARTIAL/UNVERIFIED`) e `segments`.

Cada `segment` traz offsets de texto decodificado UTF-16, `textSha256`, `status`, `method`, `evidenceUrls` oficiais e `supportingActs` quando cabível. Texto corrente só pode vir de método `OFFICIAL_CONSOLIDATION` ou `OFFICIAL_AMENDMENT`, apoiado por URL oficial. Um site ter um título/estilo atual, ou o ato ter sido publicado em certa data, **não comprova que o dispositivo ainda vigora**.

**Cuidado:** em uma fonte consolidada, o revisor precisa conferir alterações posteriores, revogação parcial, efeitos temporais, anexos externos e conflitos com outras normas. Hash e URL atestam integridade da extração, não a veracidade jurídica da vigência. A revisão não deve usar evidência fora da data `validAsOf`.

## 3. Comando operacional (não executar antes de aprovação)

```bash
node dist/infrastructure/database/tax13-attest-legal-scope-one.js \
  --manifest=/path/reviewed-manifest.json \
  --origin=<origin-uuid> \
  --reviewer=<reviewer-reference> \
  --reason=<governance-issue-and-review-evidence>
```

Sem `--confirm`, apenas consulta e verifica, não escreve. No diagnóstico NCM direcionado, **`inForceCount` só reflete trechos com atestação válida**; candidatos heurísticos de HTML não verificado aparecem exclusivamente em `unverifiedHeuristicPreview`, jamais como vigentes. Para gravar, exige **autorização operacional separada**, conexão `DATABASE_ADMIN_URL` e a configuração deliberada `TAX13_B4_ATTESTATION_WRITES_APPROVED=true`. Não permitir que Worker/API ou usuário de tenant acessem essa credencial. `--confirm` grava atestação e `audit_log` atomicamente, sem modificar eventos anteriores.

Na implantação, exigir dois revisores ou aprovação formal auditada (o CLI por si só **não** verifica independência do revisor). Registrar URLs oficiais verificadas, hash e dispositivo/ato alterador; anexos não conferidos devem receber `UNVERIFIED` e não produzir NCM/tag. Retirar autorização operacional ao concluir.

## 4. Pendências antes do R2 e do deploy

1. Conectar **também o batch global NCM, o classificador curado e a API/frontend** ao ledger; `selectText()` e `classificationText()` ainda mantêm a análise heurística HTML e não são prova oficial.
2. Garantir que ausência de atestação ou `UNVERIFIED` **não marque um scan novo `SUCCESS` com zero tags**, pois isso ocultaria achados de motores anteriores.
3. Desenvolver verificações próprias dos conectores DOU/CONFAZ/UF/municípios, inclusive atos posteriores e anexo PDF/XLS; não inferir vigência de `data-legal-status` remoto.
4. RLS e testes adversariais com documentos oficiais versionados, concorrência, reconstrução DOE-SP e rollout de tags históricas.
5. Reconciliar migrations 042/043/044, CI verde nos SHAs finais, parecer independente R2 atualizado, deploy e smoke reversível antes do reprocessamento exclusivo CV100/97 e CV52/91.

**Proibição:** não ligar classificação global nem `TAX13_GLOBAL_NCM_RESCAN_APPROVED`; não executar os comandos com `--confirm` nem atualizar o acervo sem o gate completo.
