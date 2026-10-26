# ANAT-04 — CHECKPOINT-02: núcleo e CI descartável

Origem **CLAUDE-COORD → GPT-EXEC**, execução R2 autorizada por Fábio. [Issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), backend PR #244, branch `feat/anat-04-core`. O [CHECKPOINT-01](CHECKPOINT-01.md) foi publicado e registrado antes desta implementação.

**57,1% — quatro de sete marcos entregues:** contrato, leitores/estrutura, entidades/operadores e consumidor controlado. São marcos de implementação; não equivalem às metas quantitativas ou ao aceite final. O marco DDL depende de PASS no workflow dedicado, ainda pendente na preparação deste commit; quando comprovado, totaliza cinco de sete (71,4%). Corpus/gold e aceite/revisão final permanecem pendentes. O estado posterior do CI e o SHA exato ficam nos comentários da issue.

## Entregas

- Leitores offline de representações fornecidas, sem consulta ao banco ou fonte. CONFAZ usa classes e marcadores; DOU/DOE-SP/RFB conservam como não identificado o que não reconhecem. Ordem, pai, cobertura exclusiva, mapa UTF-16 e células/mesclagens são preservados ou marcados parciais, sem reconstrução ambígua.
- Histórico e zonas proibidas herdados do DOM, inclusive `div`, `table`, `tr` e citações `blockquote/q`. Citação inline ambígua exclui conservadoramente o bloco e declara limitação. Estado jurídico continua desconhecido.
- Citações explícitas e abreviações formais sem resolver links; proteção de domínios; NCM 4–8 e capítulo 2 informativo, zeros preservados, catálogo controlado por código exato. Zonas proibidas não emitem NCM; histórico conserva ocorrências separadas. Nenhum reconhecimento concede aprovação.
- Faixas M01 compostas, sem expansão/prefixo comum, sem cruzar partes/linhas. Exceções M02 ligam alvos e bases ao contexto restritivo; casos ambíguos são bloqueados para NCM independente, preservando o canal temático.
- Motor puro e consumidor simulado sem importação do classificador/detector reais. Seleções do motor permanecem negativas por falta de evidência; positivas existem só em fixtures controladas do contrato/consumidor. Blocos temáticos nunca são concatenados nem usados para reextrair NCM.
- `engineHash` obrigatório, manifesto verificável de fontes e lock, geração explícita e verificação sem reescrita silenciosa no CI. Hashes de apresentação/anexos/regras também invalidam identidade.
- DDL das oito tabelas somente em `test/support`, fora do caminho produtivo de migrations. Workflow PR-only com PostgreSQL 16 descartável, ambiente/URL exatos e marcador SQL; testes atômicos e referências cruzadas. `expected_analysis_id` fixa identidade completa da saída, e status tem FK compatível. Nenhuma conexão local realizada.

## Verificação antes da publicação

73 testes sintéticos/offline passaram; integração DDL ficou ignorada localmente por ser exclusiva do CI. Typecheck, build e verificação do manifesto passaram antes da publicação. Não foram executadas regras, anotações automáticas ou métricas sobre o corpus real nem sobre as dez reservadas.

O CI do primeiro SHA `9543bbeb68f839e2078ed728b0ae87a6475f3d2d` confirmou typecheck/build, contratos e todas as unidades existentes; falha global somente no gate intencional `DRAFT_FAST_ONLY`. Isso não comprova ainda o novo SHA ou regressão completa. O novo workflow ANAT testa apenas seu banco descartável e não substitui os gates gerais.

## Revisão e bloqueios

Revisão Astra preliminar encontrou e orientou correções de contêineres, escopos/zonas herdadas, exceções, parada de frase e identidade/status SQL. Regressões sintéticas incorporadas. Rechecagem preliminar é distinta de parecer final após CI completo; não autoaprovar nem confundir a existência dos testes com metas atingidas.

`BLOCK_CORPUS_INPUTS_AND_GOLD` permanece: 12/30 publicações disponíveis, 18 originais DOE-SP/RFB ausentes, 0/30 com gold completo revisado. Recuperar as capturas originais e conferir hashes; preparar anotação por span e revisão Astra antes de medir. Não substituir por variantes truncadas nem fazer nova coleta. As dez reservadas continuam intactas, sem avaliação ou ajuste de regras por resultado delas.

ANAT-03 continua em conferência paralela, sem carga ou aplicação do dossiê. O pacote permanece draft e sem gate de merge. Proibidos/não executados: produção, migration produtiva, escrita em banco operacional ou local, Railway, coleta, alterações de taxonomia/detector/classificação/cadastros, merge e deploy.
