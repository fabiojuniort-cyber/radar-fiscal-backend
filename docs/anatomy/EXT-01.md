# ANAT-EXT-01 — documentos extensos e anexos separados

Entrega 6 da Frente 1. Somente sintéticos ("Exemplo"); sem corpus, gold, reserva ou texto oficial; sem rede.

- `src/modules/anatomy/annex-manifest.ts`
  - `buildAnnexManifest(result)`: cada anexo inline vira entrada própria (partId, rótulo, span, SHA-256 do texto exato do span, total de descendentes, contexto).
  - `linkSeparateAnnexes(main, separados)`: anexo publicado em arquivo separado mantém hash e anatomia próprios; vínculo ao ato só pela designação declarada (ex.: "ANEXO I", título após travessão ignorado). Sem cabeçalho correspondente → `annex_separate_without_heading`; designação repetida → `annex_label_duplicate`; nunca vínculo por adivinhação.
- Volume (`test/anatomy.ext.unit.test.ts`): 3.000 artigos em 20 anexos sem perda/duplicação/reordenação, cobertura completa, orçamento de tempo; acima de `maxBytes` e `maxDepth` a degradação é explícita (limitação registrada, texto retido), nunca truncamento silencioso.
- Fora do motor: não altera `build-identity` nem snapshots; nenhum contrato novo; nenhuma vigência inferida.
- Não integrado, não ativado.
