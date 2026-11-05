# ANAT — matriz de situação 02, reconciliação e proposta de composição (05/11/2026)

Governança: tribusca-control#116. Pareceres: c.6648168530 (R2 #289–#291), c.6649544018 (recheck), #292 c.6658290988 (L17), #129 c.6658291692 (D-074). Documento do EXEC: **não é revisão independente**. Complementa `STATUS-MATRIX.md` (31/10) sem reescrevê-lo.

## 1. Aceites registrados nos HEADs exatos (ciclo de 04–05/11)

| Pacote | PR | HEAD aceito | Parecer | Base declarada |
|---|---|---|---|---|
| ANAT-D03 (JSON RFB) | #279 | `103639d8` | R2 aceito (antes deste ciclo) | — |
| ANAT-D04 + R1-01 + D05 | #288 | `0069e3bd` | R2 aceito (antes deste ciclo) | #285 `2c41fbab` + #279 |
| OFFICIAL-LOT-RFB (R2-LOT-01, R1-LOT-02) | #289 | `57df900f` | APPROVED técnico OFFLINE | #288 + #279 `665b3231` |
| L11 — tipo RFB `parte` | #290 | `48240b98` (código `be36d7f4`) | APPROVED incremental | #289 |
| L14–L16 — portal Sefaz-SP (R2-SP-01, R1-SP-02) | #291 | `9e03d60c` | APPROVED técnico OFFLINE (leitor) | #288 + #279 `3fc1946b` |
| L17 — fonte `SEFAZ-SP-PORTAL` (R1-SP-03) | #292 | `023f7c46` | APPROVED técnico OFFLINE (motor/leitor) | #291 |
| D-073 (L11, L14–L16) | control#128 | `0530f74a` | APPROVED documental | — |
| D-074 (L17, L18 adiada) | control#129 | `6fdd7bd4` | APPROVED documental | #128 |

Nenhum desses aceites é integração ou liberação: **nada foi mergeado na `main`**. O #285 (`2c41fbab`) continua **congelado** (R7 NOT_PROVEN).

## 2. Linhas da matriz alteradas por este ciclo

| # | Requisito | Antes (31/10) | Agora | Evidência |
|---|---|---|---|---|
| C3 | Agrupamentos (livro…subseção) | PR (STRUCT-01) | + **Parte** RFB declarada pela fonte (offline, aceito) | #290 |
| C11 | Redações anteriores e notas editoriais | MAIN (CONFAZ); demais BLOQ | + RFB tachado (D04/D05) + **portal Sefaz-SP** `p.revogado`/`p.nota` com prova de procedência (offline, aceitos) | #288, #291, #292 |
| C14 | Documentos extensos | PARCIAL; sem teste oficial | Lote oficial de 5 INs RFB, incluindo a IN 2.121 (1 M caracteres), com regressão e reconciliação de preparação | #289 |
| C15 | Rastreabilidade trecho → origem | MAIN | + preparação capturada × reexecutada provada; identidade documento = recurso = ponteiros (portal) | #289, #292 |
| B1 | Amostra oficial com procedência | PR + BLOQ | 5 INs RFB + 2 páginas SP coletadas, **todas `promoted:false`** | #279 |
| B2 | Cobertura fonte × tipo × porte | BLOQ | RFB (IN pequena→muito grande) e Sefaz-SP portal (2 artigos); Planalto/CONFAZ/DOU dependem de arquivos manuais | #279, #289 |
| Fonte | Sefaz-SP portal × DOE-SP | inexistente | fonte tipada `SEFAZ-SP-PORTAL` no contrato do **motor** (sem banco) | #292 |

## 3. Lacunas restantes

| # | Lacuna | Estado | Depende de |
|---|---|---|---|
| L1 | IN 2.237: blocos tipo 999 ("não identificado" pela fonte) | Limitação; sem adivinhação | Decisão, se houver |
| L2/L12 | Anexos RFB sem conteúdo (IN 2.121: 31) | `missing` | Coleta dos binários + escopo |
| L3 | Amostras oficiais promovidas | 0 | Gate de promoção específico |
| L4/L5 | Planalto (PIS/Cofins) e CONFAZ | Não coletados | Arquivos manuais **M1–M5** (Fábio) |
| L6 | Cabeçalho/rodapé (entrega 4) | Não iniciado | **M9** (Fábio) |
| L7 | DOE-SP Diário Oficial (lote 2) | Não iniciado | Depois de M9 |
| L8 | Integração na `main` | #285 congelado | R7 (Frente 2) + decisão |
| L9 | REL-01 (implementação) | Só desenho | Autorização |
| L10 | Homologação cega com o 52/91 | Não iniciada | Fases finais |
| L13 | IN 2.121 usa 92% do limite de 2 MB | Risco de volume | Decisão sobre o limite, se surgir ato maior |
| L18 | `blockquote` como recuo no portal SP | **Adiada** (D-074) | Novas amostras + aprovação |
| L19 | Persistência da fonte `SEFAZ-SP-PORTAL` (CHECK da migration 077), perfis administrativos e coletor | Não implementado | **Decisão futura + migration** |
| L20 | Citação aberta no segmento 4008 (tipo 999) da IN 2.121 | Diagnóstico feito (§7): 556 blocos, 106.841 caracteres (10,6%), 118 artigos e a PARTE VI até o fim do ato ficam `prohibited` | Decisão sobre aspas sem fechamento em segmento 999 |
| L21 | Caractere invisível U+200B no portal SP | Diagnóstico feito (§7): 15 ocorrências; **só 1 bloco** não é reconhecido por causa dele (inciso XV do art. 7º, 103 caracteres). Os outros 68 caracteres do art. 39 têm outra causa | Decisão (normalização), se desejada |

## 4. Reconciliação do percentual (fórmula vigente)

Fórmula: peso × (0,40 implementado + 0,20 testado + 0,20 revisão aceita + 0,10 integrado + 0,10 liberado). Sem pesos novos.

| Etapa | Valor registrado | Variação neste ciclo | Motivo |
|---|---|---|---|
| Implementado (máx. 40) | 24,0 | 0 | Os pacotes L11, L14–L17 e LOT-RFB vieram de decisões sem peso próprio (como D04/D05, c.6647087145); não completam item ponderado por si |
| Testado (máx. 20) | 11,2 | 0 | idem |
| Revisão aceita (máx. 20) | 12,0 | 0 | Aceites offline de pacotes sem peso; o aceite não conta como integração |
| Integrado (máx. 10) | 1,5 | 0 | Nada integrado (#285 congelado; nenhum merge) |
| Liberado (máx. 10) | 1,5 | 0 | Só CONFIG-01 (flags desligadas) |
| **Total** | **50,2%** | **0** | |

**Frente 1 = 50,2%; Frente 2 = 10%** (inalterados).

**Limitação da reconciliação:** a tabela de peso **por item** não está em arquivo versionado. Só os totais por etapa estão registrados (handover e #116). A conclusão "variação 0" segue a regra aplicada pelo COORD a D04/D05 ("sem peso novo"). Se o COORD tiver a tabela por item e algum desses pacotes completar um item ponderado (ex.: C11 ou B1), o valor deve ser recalculado por ele.

## 5. Proposta de composição dos pacotes offline revisados (NÃO executada)

**Objetivo:** um único candidato para revisão, contendo #288 → #289 → #290 e #288 → #291 → #292. **Fora:** o #285 (congelado) e a `main`.

**Grafo de dependências**
```
#279 (snapshots) ─┐
#285 2c41fbab ─ #288 0069e3bd ─┬─ #289 57df900f ─ #290 48240b98   (RFB)
                               └─ #291 9e03d60c ─ #292 023f7c46   (Sefaz-SP)
```
Os dois ramos já contêm o #288, portanto também o conteúdo do #285 `2c41fbab`. Compor **não** altera o #285, mas o candidato **herda** a pilha bloqueada por R7. Por isso ele não pode ir à `main` antes do R7 e de decisão de integração.

**Prova local feita** (worktree temporária, descartada, **sem push**): merge de `#290` em `#292`.
- **Conflitos (3), todos em arquivos gerados ou na guarda:** `docs/anatomy/engine-build.json`, `src/modules/anatomy/build-identity.ts` e a guarda em `test/anatomy.base-migration.integration.test.ts`.
- `readers.ts` combinou automaticamente (L11 no mapa RFB; L14–L17 no portal).
- **Resolução:** regenerar a identidade com `build-identity.mjs --write` (prova: `afb275ec`), atualizar a guarda e regenerar a baseline do lote com `official-lot-rfb.ts --write`.
- **Resultado da prova:**
  - ANAT unit **310/310**; `tsc` OK; `verify-build` OK; PG16 **12/12**; snapshot sintético inalterado;
  - lote RFB com estrutura **idêntica** à do #290 nas 5 INs (só o `outputHash` muda, por causa da identidade).

**Testes necessários no candidato real:**
1. Gate local completo: `tsc`, `test/anatomy*.unit.test.ts`, `anatomy:verify-build`, integração PG16, snapshot sintético.
2. Lote RFB: baseline regenerada; estrutura igual à do #290; reconciliação de preparação (`identical` ×4, `d04_annotation_only` ×1).
3. Portal SP pelo motor (`SEFAZ-SP-PORTAL` + prova): art. 7º 103/12/1; An. II art. 39 68/3/14; adversariais L17.
4. DOE-SP e RFB lidos pelo leitor: SHA da saída igual ao dos ramos de origem.
5. CI no SHA unido (`anatomy-ci`; a base precisa estar no filtro de branches) e revisão independente R2 do candidato.

**Execução:** só com autorização expressa. Seria um branch novo, sem tocar o #285 e sem merge na `main`.

## 6. Próximo trabalho executável no escopo atual (sem nova decisão)

1. **Diagnóstico L20:** encontrar o segmento que abre a citação antes da PARTE VI da IN 2.121 e documentar. Sem alterar a regra de citação.
2. **Diagnóstico L21:** inventariar os U+200B nas 2 páginas SP e o efeito em cada bloco. Sem normalizar; a correção dependeria de decisão.
3. **Coleta de fontes acessíveis** (API RFB e portal Sefaz-SP), sem promover: novos atos de DCTF e PIS/Cofins e mais artigos do RICMS, para alimentar L18/L20/L21.
4. **Composição (§5):** pronta para executar quando autorizada.

**Bloqueados:** M1–M5 e M9 (arquivos manuais do Fábio); L19 (migration); L18; integração e R7; promoção (L3).

Invariantes: `legalStatus` `unknown`; `promoted:false`; recusa de tachados no vínculo; `BLOCK_CORPUS_INPUTS_AND_GOLD`; `RESTRICT`; 52/91 e 100/97 fora do desenvolvimento.

## 7. Diagnósticos L20 e L21 (somente leitura; nada corrigido)

**L20, IN RFB 2.121/2022 (127905):**
- O segmento `ordemSegmentoAto` 4008 (`/outrosSegmentos`, tipo **999** "não identificado" pela fonte, não tachado) começa com aspa reta: `"Art. 706. O projeto de investimentos…`. Ele não tem aspa de fechamento nem `(NR)` (370 caracteres). O segmento anterior, 4007, é o mesmo art. 706 tachado (histórico).
- Efeito: o leitor abre `openQuotation` e nunca fecha. Dali até o fim do ato, **556 blocos** viram `quoted_text`/`prohibited`: 106.841 de 1.009.001 caracteres (10,6%), com 118 blocos que começam por "Art. N", a PARTE VI e o último trecho ("ANEXO XXIX").
- Esses 556 blocos são **todos** os `quoted_text` da IN 2.121.
- Natureza: o resultado é conservador (nada indevido vira operativo), mas perde estrutura. Uma correção (ex.: limitar a citação ao segmento RFB que a abriu, ou exigir fechamento) muda a regra de citação. **Não autorizada; depende de decisão.**

**L21, portal Sefaz-SP (caminho L17 com prova):**
- art. 7º: 5 × U+200B no texto canônico. 1 bloco não identificado por causa dele: "​XV - a saída, com destino a outro estabelecimento…" (103 caracteres), que seria inciso sem o caractere.
- An. II art. 39: 10 × U+200B, sem bloco afetado. Os 68 caracteres não identificados são "(Relação a que se refere o artigo 51…)" (66) e 2 restos de 1 caractere.
- **Correção do registro anterior:** os casos "§ 6º" e "NOTA - V. DECRETO 54.006" citados na L14–L16 não aparecem mais como não identificados no caminho atual.
- Normalização não autorizada; o texto continua literal.

## 8. Coleta finita priorizada (fontes já autorizadas; sem promover; sem corpus/gold)

| # | Fonte | O que buscar | Lacuna que alimenta | Critério de parada |
|---|---|---|---|---|
| 1 | API RFB | 1 ato além da IN 2.121 cuja tabela `tiposSegmento` declare `parte` | L11 (regressão em 2º ato) | 1 ato encontrado ou 10 consultas sem achado |
| 2 | API RFB | 1 ato com segmento 999 que abre aspas | L20 (recorrência) | idem |
| 3 | API RFB | Metadados de tamanho dos maiores atos consolidados | L13 (limite de 2 MB) | Só metadados; no máximo 10 atos |
| 4 | API RFB | Verificar se o anexo binário da IN 2.121 tem endpoint oficial | L2/L12 | 1 consulta de verificação; coletar 1 anexo só se acessível |
| 5 | Portal Sefaz-SP | 2 artigos do RICMS com alíneas `revogado` dentro de `blockquote` | L18 (amostras para decisão futura) | 2 páginas |
| 6 | Portal Sefaz-SP | 2 artigos do RICMS sem escolha dirigida | L21 (frequência de U+200B) e regressão L14–L17 | 2 páginas |

Total: no máximo 7 atos ou páginas mais metadados. Tudo vai para `promoted:false`, com URL, data, SHA e procedência. Planalto, CONFAZ e DOU continuam dependentes de M1–M5 e M9.

## 9. Adendo de estado (05/11, após as revisões do COORD; §1–§8 preservados como histórico)

- **§4 (reconciliação):** a tabela de pesos **está versionada** em `PROGRESS-BASELINE-13.md`. O COORD validou a reconstrução (24,0 + 11,2 + 12,0 + 1,5 + 1,5 = 50,2; E10 sem o marco "testado") e **não reconhece** os marcos de E9 (c.6665613398). **Frente 1 = 50,2%; Frente 2 = 10%.**
- **E9, critério de conclusão (COORD):** completar e demonstrar a matriz oficial de cobertura — fontes, tipos e portes (pequeno, médio, grande, quando aplicável), incluindo as categorias ainda ausentes. Sem pontuação fracionária. A promoção é registrada à parte e não é condição dos marcos offline.
- **§5/§6 (composição):** a composição **foi executada** como candidato entregue: **#294 @ `871ed557`** (merge normal de #292 `023f7c46` + #290 `48240b98`), com APPROVED técnico OFFLINE (c.6665602892). A "prova local" do §5 foi uma worktree **temporária e descartada**. O candidato entregue é o #294; os dois não se confundem. O #294 herda o #285 e **não** está liberado para a `main`.
- **Próximo executável:** a coleta finita do §8 (6 itens, com os limites publicados), sem promover, sem corpus/gold/reserva e sem contornar desafios ou recusas de rede.

## 10. Propostas L20 e L21 (AS IS / TO BE; nada implementado; decisão do Fábio)

### L20 — aspa sem fechamento em segmento RFB tipo 999 (IN 2.121, segmento 4008)
**AS IS:** o leitor abre `openQuotation` numa aspa de início de bloco e só fecha com aspa de fim (ou `(NR)`). No RFB, o segmento 4008 (tipo 999, 370 caracteres) abre e não fecha. Resultado: 556 blocos (106.841 caracteres, 10,6%) ficam `quoted_text`/`prohibited` até o fim do ato, incluindo 118 artigos e a PARTE VI.

| Alternativa | TO BE | Efeito na rastreabilidade | Risco | Contracasos obrigatórios |
|---|---|---|---|---|
| A (recomendada) | **Só para RFB:** a citação aberta dentro de um segmento JSON (`<section data-rfb-segment>`) é encerrada no fim **desse** segmento, com limitação `rfb_quote_unclosed_in_segment` apontando o segmento. O bloco que abre continua `quoted_text`/`prohibited`. | Inalterada: o limite vem da fronteira do segmento da própria fonte, já rastreada | Uma citação RFB legítima que continue em vários segmentos deixaria de ser citação nos segmentos seguintes | (1) citação multissegmento real com aspa de fechamento no segmento N+k (deve continuar citação, ou ser recusada pela regra, e a escolha deve ser explícita); (2) DOU/DOE-SP/CONFAZ sem mudança; (3) tachado + citação; (4) `(NR)` |
| B | Encerrar só quando o segmento seguinte declara tipo estrutural (artigo, parte, livro…) | Inalterada | Depende dos tipos declarados; não resolve sequências de tipo 999 | Mesmos de A, mais sequências 999 |
| C | Manter como está (só a limitação) | — | Perda de 10,6% da IN 2.121 | — |

**Recomendação:** A, porque usa só a fronteira declarada pela fonte e não muda as outras fontes. Muda a regra de citação; **requer decisão expressa**.

### L21 — U+200B (espaço de largura zero) no portal Sefaz-SP
**AS IS:** 15 ocorrências nas 2 páginas; **1 bloco** não é reconhecido (inciso XV do art. 7º, 103 caracteres). O texto canônico é literal.

| Alternativa | TO BE | Efeito na rastreabilidade | Risco | Contracasos obrigatórios |
|---|---|---|---|---|
| A (recomendada) | **Só para casar a gramática:** ignorar U+200B **no início** do bloco ao testar os marcadores (inciso, §, alínea, NOTA). O texto canônico, os spans e os hashes continuam **literais** (nada é removido). | Inalterada: nenhum caractere removido, spans iguais | Mínimo; vale só para o caractere U+200B no início | (1) bloco com U+200B no início vira inciso; (2) U+200B no meio do texto não muda nada; (3) outros invisíveis (U+200C/U+200D/U+2060/U+FEFF) **não** são tratados sem decisão; (4) DOU/RFB sem mudança |
| B | Normalizar (remover) U+200B no texto canônico | **Muda** offsets e hashes; exige mapa de normalização (análogo ao UNICODE-01b) | Maior | — |
| C | Manter | — | 1 bloco não identificado | — |

**Recomendação:** A (só tolerância no casamento, sem alterar o texto). Muda a gramática; **requer decisão expressa**.

## 11. 🔴 DECISÕES DO FÁBIO — AGUARDANDO (nada implementado)

| ID | Assunto | AS IS | TO BE recomendado | Benefício | Risco | Testes necessários | Etapa dependente |
|---|---|---|---|---|---|---|---|
| 🔴 **L20** | Aspas sem fechamento em segmento RFB tipo 999 | IN 2.121: 556 blocos (10,6%) `prohibited` até o fim; IN 2.021: 68 blocos (8,2%) (COLETA-02) | Alternativa A do §10: só para RFB, encerrar a citação aberta no fim do segmento JSON que a abriu, com limitação explícita | Recupera a estrutura (118 artigos e a PARTE VI na 2.121) sem tocar as outras fontes | Citação RFB legítima que atravesse segmentos | Multissegmento com fechamento; outras fontes sem mudança; tachado + citação; `(NR)`; lote RFB antes/depois | E9 (qualidade da cobertura RFB) |
| 🔴 **L21** | U+200B no início do bloco (portal SP) | 1 bloco afetado (art. 7º, inciso XV); 0 nas 4 páginas novas | Alternativa A do §10: tolerar U+200B **no início**, só para casar a gramática; texto, spans e hashes literais | 1 bloco reconhecido; nenhum efeito no texto | Mínimo | Início × meio do bloco; outros invisíveis fora; DOU/RFB sem mudança | — |
| 🔴 **L22** (nova) | Tipo RFB `anexo` declarado e sem mapeamento | 2 e 4 limitações nas INs 1.911 e 2.021 | Mapear `anexo` declarado → `annex`, só quando a gramática deixou o bloco não identificado (mesmo modelo da L11) | Menos limitações; anexos estruturados | Igual à L11 (conflito com a gramática fica registrado) | Contracasos da L11 aplicados a `anexo` | E9 |
| 🔴 **L2/L12** (atualizada) | Anexo HTML embutido no JSON RFB | 1 de 31 anexos da IN 2.121 está no JSON (base64) e não é lido | Preparação RFB passa a ler o anexo HTML embutido, com spans próprios; PDFs (tipo 6) continuam `missing` | Conteúdo de anexo oficial sem nova coleta | Muda a preparação RFB (nova versão; reconciliação de preparação como no #289) | Preparação capturada × reexecutada; HTML do anexo sem execução de script; tamanho | E9 |
| 🔴 **LOTE-RFB+** | Incluir IN 1.911 e IN 2.021 no lote de regressão | Coletadas em pasta separada, fora do lote aprovado | Ampliar o lote de 5 para 7 INs (nova baseline) | Regressão cobre L11 em 2 atos e L20 | Nenhum funcional; a baseline muda | Teste do lote com 7 atos | — |
| 🟡 L18 | `blockquote` como recuo (portal SP) | **Adiada** (D-074); amostras novas: An. I art. 41 (25) e An. II art. 3º (7) | — | — | — | — | Nova aprovação |
| 🟡 L19 | Persistência da `SEFAZ-SP-PORTAL` | **Não autorizada** (migration) | — | — | — | — | Autorização |

Formato da resposta: por exemplo, "L20 = A; L21 = A; L22 = aprovado; L2/L12 = adiado; LOTE-RFB+ = aprovado".
