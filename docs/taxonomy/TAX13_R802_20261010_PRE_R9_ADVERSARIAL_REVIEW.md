# Trifaros — TAX13-R8-02 | pré-revisão adversarial de código e RFC (10/10/2026)

**Escopo:** backend PR #194, baseado em #193; checkpoint inicial `f95db62c2918b30596d621f1008b30417afe8db7`. Revisão feita no mesmo fluxo de execução do desenvolvimento, **NÃO É R9 independente**, não autoriza CURRENT, migração, merge ou produção. Decisão do proprietário: PDF original de fonte governamental confiável basta para comprovar PUBLICAÇÃO; não pedir certificados digitais/ICP/ITI/OCSP/CRL. Vigência é prova separada.

## Achado reprodutível de leitura estática e remediação

**R802-DATE-01 — P1 (lacuna de conferência documental).** Em `dou-official-text-correspondence.ts` o cabeçalho exigia edição correta, mas **não validava a data impressa** contra `trace.publicationDate`: texto com título/ato integral e cabeçalho de data diferente passaria a `DOU_PDF_ACT_TEXT_CORRESPONDS_ONLY` (sempre com `grantsLegalCurrent=false`). Foi corrigido no commit `5c1e1f4ce3651445d8f574e0ac886fddb5ac4910`: conferência da data textual por extenso ou numérica, restrita à região do cabeçalho anterior ao despacho. Testes adicionais no commit `56e1b67f4b0e8270b0bfe54573d916a5e6ffd7f8` rejeitam data errada ou correta apenas após o ato e aceitam data numérica. Verificar a extração nativa de PDFs reais antes de promover esta regra além da camada documental.

## Matriz de riscos e gates (sem substituir R9)

| Área | Situação | Bloqueio / teste exigido |
| --- | --- | --- |
| Captura HTTPS e URL oficial | Implementada, tests de contrato | Verificar as mesmas regras no worker executado e impedir retarget/redirect/receipts importados |
| PDF/INLABS data, masthead e texto | Endurecido no código; testes sintéticos | Reproduzir com PDF oficial e XML original, incluindo ordem nativa de leitura e texto completo |
| Extra 80, 80-A e 80-B | **BLOCK para admissão SQL** | Fonte de índice/jornal que vincule o ID 601 ao sufixo 80-B; não confiar só em `DO1E` e `editionNumber=80` |
| Fonte HTTP real x PDF upload | **UNVERIFIED** | PDF GET Railway hash `9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44`; PDF upload hash `e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201`. Bytes oficiais do GET descartados, sem prova de igualdade textual |
| Guard 048 e integração TAX-11/R7 | **BLOCK** | Fixture tenta proof positivo sem origem HTTP admitida. Falha `TAX13_R8_ORIGINAL_HTTP_UNVERIFIED` deve continuar bloqueando; não inventar recibo nem remover teste |
| RFC SQL DOU | **DESIGN-ONLY** | Não existe migration 049+ aprovada ou aplicada; validar schema, provenance trust boundary, RLS, FORCE RLS, append-only, função SECURITY DEFINER e funções de admissão |
| Ratificação e efeitos 15/24 | Cronologia factual parcial | Buscar emendas/revogação e efeitos POR DISPOSITIVO na data de referência; não elevar a CURRENT por AD 10/24 isolado |
| Liberação R9 / produção | **BLOCK** | Revisão adversarial por agente independente, PG16/18 positivos legítimos e negativos, CI integral e autorização posterior |

## Condições necessárias antes da migração 049+

1. **Limite de confiança:** `correlateOfficialDouPdfActText` recebe uma estrutura `sourceCapture` como argumento exportado. Um objeto em memória pode ser fabricado por outro chamador, embora o orquestrador `fetchAndMatchOfficialDouPdfAct` derive isso do fetch real. Nenhum DTO, upload, argumento de função ou resultado isolado desse correlator pode alimentar uma tabela de prova positiva. A admissão deve acontecer dentro da trilha de execução restrita que une URL controlada, bytes HTTPS, extração, XML e conferência — vinculada a registro de execução verificável e identidade de processo autorizada.
2. **Identidade forte:** chave distinta por data + seção + jornal + sufixo oficial da edição + página + matéria INLABS + despacho + ato; tratar regular, A e B separadamente. `printedEdition` passado pelo chamador não é fonte independente.
3. **Auditoria econômica:** manter eventos de tentativa (`CAPTURED`, `UNAVAILABLE`, `ERROR`, `REJECTED`) com hora, URL, erro sanitizado, SHA, parser, resultado de correspondência e versão. Não gravar PDFs/JPGs no PostgreSQL. Se o PDF não for retido, documentar explicitamente que a auditoria futura pode precisar de novo download e que hashes diferentes não provam texto igual ou diferente.
4. **Revisão SQL adversarial:** ninguém além da credencial estrita do coletor pode simular um `CAPTURED` positivo ou um `TEXT_CORRESPONDS`; o serviço de coleta deve validar o conteúdo recebido, não aceitar status/bytes/hashes informados por API. Testar usuário app, worker, curator, issuer, scan sealer, tenant A/B, trigger UPDATE/DELETE, replay, conflito, concorrência, rotação de credenciais, ausência de fonte e data da edição adulterada em PG16 e PG18.
5. **Vigência e clientes:** manter classificação jurídica por fragmento/cláusula, datas e alterações independentes da mera captura. Cross-tenant só a publicação canônica; relevância individual é derivada e isolada por tenant. Ausência de publicação na coleta bem-sucedida não se confunde com erro/indisponibilidade.

## Evidências de execução

- PR #194: https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/194
- Testes DOU dedicados no commit com alteração: https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38024978285 (**PASS na consulta de 10/10/26**)
- Compatibilidade CONFAZ offline: https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38024978327 (**PASS**)
- Outros gates da execução ainda em validação na redação deste documento; conferir no HEAD final, não extrapolar PASS.
- Ambiente Railway `tax13-r802-temp-20261009/r802-temporary` inventariado em 10/10/26: **zero serviços, volumes, buckets e alterações staged**.

**Decisão local:** documentação e correção fail-closed da data são seguras para branch isolada; RFC não deve virar migração ou admissão CURRENT antes de R9-DESIGN independente. Nenhum deploy/merge/produção/coleta histórica/reprocessamento permitido.