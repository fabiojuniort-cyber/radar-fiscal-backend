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

## 12. Adendo após o parecer do COORD (#293 c.6671592095)

- **L20:** a alternativa A (encerrar sempre no fim do segmento) **pode liberar uma continuação legítima** de citação. **Recomendação revista: manter a regra atual** até definir um critério conservador com contracasos (ex.: só encerrar quando o segmento seguinte declara tipo estrutural **e** não começa com marcador de continuação, com teste multissegmento real). 🔴 L20 continua pendente, sem proposta pronta para decisão.
- **Prontas para decisão expressa do Fábio:** 🔴 **L21 = A**; 🔴 **L22** (restrito ao tipo `anexo` declarado pela tabela do próprio documento); 🔴 **LOTE-RFB+** (lote de 5 para 7 INs).
- **L2/L12:** pendente até haver desenho de limites, procedência, spans e reconciliação da preparação; não vai à decisão agora.
- L18 adiada; L19 não autorizada. Frente 1 = 50,2%; Frente 2 = 10%.

## 13. Desenhos pedidos (só desenho; nada implementado) — COORD/Fábio, #116 c.6671833324

### 13.1 L20 — critério conservador para aspas abertas em segmento RFB

**Evidência nova (somente leitura, nos snapshots oficiais):**
- **IN 2.021/2021 (116968): 18 citações legítimas atravessam segmentos.** Exemplo: o segmento 678 (tipo 999, `"Art. 142. …`) abre a citação, e ela só fecha no segmento 682 (tipo `inciso`), 4 segmentos depois. Outro: 683 → 686. A antiga alternativa A (fechar sempre no fim do segmento) **liberaria esses incisos citados como operativos**. Por isso foi descartada.
- **IN 2.121 (127905):** 1 abertura (segmento 4008, tipo 999) **sem nenhum fechamento até o fim do ato**. Os segmentos seguintes são os §§ do art. 706 citado (4009 `paragrafo` tachado, 4010 `paragrafo`, …).
- IN 1.911 (104314): nenhuma abertura sem fechamento.

**Critério proposto (todas as condições, só para RFB):**
1. **(a) Ausência de fechamento:** só se considera encerrar uma citação aberta no segmento S se **nenhum** segmento posterior do mesmo ato contiver fechamento (aspa de fim ou `(NR)`) antes da próxima abertura. A preparação conhece todos os segmentos; o leitor recebe isso como atributo de prova (`data-rfb-quote-unclosed="true"`) gravado pela preparação, nunca deduzido do texto da página.
2. **(b) Continuação protegida:** mesmo com (a), os segmentos seguintes que pertencem ao dispositivo citado (`paragrafo`, `inciso`, `alinea`, `item` ou 999) **continuam `prohibited`**. A citação só termina **antes do próximo segmento declarado `artigo` ou agrupamento (`parte`, `livro`, `titulo`, `capitulo`, `secao`, `subsecao`)** que não comece com aspas.
3. **(c) Evidência:** o bloco de abertura continua `quoted_text`/`prohibited`. É registrada a limitação `rfb_quote_unclosed_bounded`, com o segmento de abertura e o de retomada.
4. Outras fontes: sem mudança. `legalStatus` `unknown`.

**Efeito esperado:**
- IN 2.121: os §§ do art. 706 citado continuam proibidos; o texto volta ao normal a partir do próximo artigo **declarado** depois do 4008. Recupera a maior parte dos 556 blocos; o número exato será medido.
- IN 2.021: **nenhuma mudança**, porque as 18 citações têm fechamento e falham em (a).

**Contracasos obrigatórios:**
1. **Citação legítima multissegmento** (modelo real 116968, 678 → 682): abre em 999, fecha num inciso posterior. Deve continuar `quoted_text` em todos os segmentos.
2. Abertura sem fechamento seguida só de §§ e incisos até o fim: tudo continua `prohibited` (não há artigo declarado para retomar).
3. Abertura sem fechamento seguida de artigo declarado **que começa com aspas**: não retoma.
4. Fechamento só por `(NR)`: conta como fechamento.
5. Tachado dentro da citação: continua `historical`/`prohibited`, conforme as regras atuais.
6. DOU, DOE-SP, portal SP e CONFAZ com o mesmo HTML: sem mudança.
7. Lote de 7 INs antes/depois, com cada diferença explicada.

**Risco residual:** uma citação legítima cujo fechamento a fonte omitiu **e** que contenha um artigo inteiro citado seria encerrada antes desse artigo. Mitigação: (b) exige tipo **declarado** pela fonte, e a limitação deixa o caso auditável. 🔴 **Requer decisão expressa** depois da revisão deste desenho.

### 13.2 L2/L12 — leitura do anexo HTML embutido no JSON RFB

**Evidência:** IN 2.121, segmento **702** (o mesmo do conflito da L22: declarado `anexo`, texto do art. 137), `arquivoBinario.idTipoArquivo = 5`, nome `IN1.html`, **5.643 bytes** em base64, `charset=windows-1252` declarado no próprio HTML, sem `<script>`. Os outros 30 anexos (tipo 6, PDF) não trazem conteúdo no JSON.

**Desenho:**
1. **Seleção:** só `idTipoArquivo` cujo conteúdo base64 decodifica para HTML (assinatura `<!DOCTYPE`/`<html`) e declara charset suportado (`windows-1252`, `iso-8859-1`, `utf-8`). Caso contrário, o anexo continua `missing`, com motivo.
2. **Limites:** no máximo 512 KiB decodificados por anexo e 1 MiB por ato. O HTML preparado total continua sujeito ao limite do leitor (2 MiB; hoje a IN 2.121 usa 88%, então anexos grandes podem levar a `input_size_limit`, com degradação explícita). Acima disso: `attachment_too_large`, sem leitura parcial silenciosa.
3. **Procedência:** ponteiro `/outrosSegmentos/<i>/arquivoBinario/arquivoBinario`, SHA-256 dos bytes decodificados, charset usado e `idArquivoBinario`/nome. O texto vem só da representação oficial já capturada (sem nova coleta).
4. **Posições no original:** o anexo entra como `<section data-rfb-attachment="<idArquivoBinario>">` depois do segmento que o referencia. O `PreparedPiece` registra o intervalo no HTML preparado **e** o intervalo nos bytes decodificados do anexo, que é reproduzível a partir do base64 do JSON.
5. **Saneamento:** o leitor já exclui `script`, `style`, `iframe` etc. O `<head>` do anexo fica fora. Nenhum recurso externo é buscado.
6. **Versão e reconciliação:** a preparação RFB sobe para `0.3.0`. No lote, a reconciliação ganha o modo `inline_attachment_added`: remover exatamente as `<section data-rfb-attachment>` inseridas deve reproduzir o hash `0.2.0` (mesma técnica do R2-LOT-01). Atos sem anexo embutido continuam `identical`. A preparação capturada nunca é reescrita.
7. **Contexto:** o conteúdo do anexo herda o contexto do segmento que o referencia (tachado → `historical`; citação → `prohibited`); `legalStatus` `unknown`.

**Testes necessários:**
- anexo HTML válido lido, com ponteiro e SHA;
- base64 inválido, charset não suportado e conteúdo que não é HTML → `missing` com motivo;
- limite por anexo e por ato;
- PDF tipo 6 continua `missing`;
- reconciliação `inline_attachment_added` e falha se outra coisa mudar;
- HTML com `<script>`/`<iframe>` não executado nem lido;
- lote de 7 INs antes/depois.

🔴 **Requer decisão expressa** depois da revisão deste desenho.

## 14. Revisão dos desenhos (parecer COORD de 06/11) e plano de composição — só desenho e planejamento

### 14.1 L20 revisado — proteger o artigo citado inteiro; procedência da marca

**Mudança em relação ao §13.1(b):** a retomada não depende só de haver um "próximo artigo declarado". O artigo citado inteiro fica protegido.

1. **(a) Sem fechamento:** como no §13.1. Nenhum segmento posterior contém fechamento antes da próxima abertura.
2. **(b') Artigo citado inteiro:** se o bloco de abertura começa por um rótulo de artigo (`"Art. N`), o número **N** é registrado. A citação só termina antes de um segmento declarado `artigo`, não tachado e sem aspas, cujo número é **o sucessor de N na numeração do ato** (N+1, ou N-A/N-B quando a sequência local os usa). Segmentos `paragrafo`, `inciso`, `alinea`, `item`, 999 e qualquer artigo com número ≤ N ficam `prohibited`. Se não houver rótulo de artigo na abertura, ou não existir sucessor, **nada é liberado** (regra atual).
   - **Evidência (IN 2.121):** abertura no segmento 4008 = "Art. 706"; último artigo operativo antes = 705 (segmento 4005); próximo artigo declarado = **707** (4014), sem aspas e não tachado. Ficam protegidos os §§ do art. 706 (4009–4013); a leitura normal volta no 707.
3. **(c) Procedência da marca (como na L17):** o leitor **não** lê nenhum atributo de HTML para isso.
   - A preparação RFB calcula, a partir do JSON oficial, o plano `rfbQuoteBounds` (segmento de abertura, N, segmento de retomada, motivo).
   - O plano é entregue **por referência** num objeto de preparação emitido pelo `prepareRfbRepresentation` (`WeakSet` privado, congelado em profundidade, ligado ao SHA do HTML e ao `representationId`).
   - Sem prova válida, vale a regra atual. Uma marca escrita no HTML (`data-rfb-quote-*`) é ignorada. Teste negativo obrigatório: marca forjada, objeto copiado, HTML alterado, id divergente.
4. **(d) Evidência:** a limitação `rfb_quote_unclosed_bounded` registra o segmento de abertura, N e o segmento de retomada. O bloco de abertura continua `quoted_text`/`prohibited`.

**Contracasos (somam-se aos do §13.1):**
- citação legítima multissegmento da IN 2.021 (678 → 682): **sem mudança**;
- citação sem fechamento de um artigo que contém "Art. N+1" **dentro** da própria citação, mas entre aspas ou como 999: não retoma;
- abertura sem rótulo de artigo: não retoma;
- sucessor ausente até o fim: não retoma;
- sucessor tachado: não retoma nele, só no seguinte não tachado.

### 14.2 L2/L12 revisado — isolamento, corpo, mapa de origem e reconciliação desde 0.1.0

**Mudança em relação ao §13.2(4):** o anexo **não** é inserido no HTML principal.

1. **Isolamento de HTML malformado:** cada anexo HTML embutido vira um **recurso separado** (`resourceId = rfb:<idAto>:anexo:<idArquivoBinario>`), lido numa passada própria do leitor. Tags abertas, `</section>`, comentários ou entidades quebradas no anexo **não alteram** a árvore nem o texto do ato. A passada do anexo usa os mesmos limites do leitor (profundidade, nós, bytes). Se falhar, o anexo fica `unreadable`, com motivo, e o resto do ato não muda.
2. **Preservação do corpo:** os bytes decodificados do base64 são guardados como estão (SHA-256 registrado). O charset é o declarado no próprio anexo; se não for suportado → `missing`. Nada é normalizado ou reparado. O `<head>` e scripts são excluídos pelo leitor, como em qualquer HTML.
3. **Mapa de origem:** as partes do anexo têm `sourcePointers.resourceId` igual ao do recurso do anexo e spans nos bytes decodificados. A origem completa é JSON → `/outrosSegmentos/<i>/arquivoBinario/arquivoBinario` (base64) → bytes → spans. O ato ganha uma parte `annex` que referencia o recurso, sem copiar texto.
4. **Reconciliação desde 0.1.0:**
   - o **HTML principal não muda**, então a cadeia existente continua válida: 0.1.0 →(D04: só atributos)→ 0.2.0 → 0.3.0, com HTML principal **idêntico** ao 0.2.0;
   - a 0.3.0 acrescenta só a lista `inlineAttachments` (id, ponteiro, SHA dos bytes, charset, tamanho, estado);
   - no lote, a reconciliação vira `d04_annotation_only` (IN 2.121, captura 0.1.0) mais `inline_attachments: N`, com o hash da preparação principal provado igual;
   - a preparação capturada no `.meta.json` **nunca é reescrita**.
5. **Limites:** 512 KiB decodificados por anexo e 1 MiB por ato. Acima disso → `attachment_too_large`. PDFs (tipo 6) continuam `missing`.

**Testes:**
- HTML malformado (tags abertas, `</section>`, comentário aberto): o ato fica idêntico e o anexo é lido ou marcado `unreadable`;
- base64 inválido; charset desconhecido; conteúdo que não é HTML;
- limites por anexo e por ato;
- a reconciliação prova HTML principal idêntico desde 0.1.0 (via 0.2.0);
- ponteiros do anexo apontam para o recurso do anexo;
- lote de 7 INs antes/depois.

### 14.3 Plano de composição de #296 + #297 + #298 (não executado; aguarda decisão)

**Ordem:** base = **#298 @ `47d166b4`** (contém #295 e #294) ← merge normal de **#296 @ `e6b0dbb0`** ← merge normal de **#297 @ `cb8a9773`**. Branch nova; #285, `main` e ramos do R7 intocados. O candidato herda o #285 e **não** é liberável para a `main`.

**Prova local feita** (worktree temporária, descartada, sem push):

| Passo | Resultado |
|---|---|
| #298 ← #296 | Sem conflito textual. Atenção: a baseline do lote vinda do #298 (identidade `afb275ec`) fica desatualizada; é regenerada no fim |
| ← #297 | Conflitos em `engine-build.json`, `build-identity.ts`, `official-lot-rfb.json` e na guarda da integração |
| `readers.ts` | **Combinou automaticamente**: L21 no bloco do portal SP; L22 no mapa de tipos RFB e em `rfbDeclared`. São trechos distintos |

**Separação pedida:**
1. **Resolução semântica em `readers.ts`** (primeiro commit do candidato, revisável isoladamente): conferir que o resultado do merge automático contém as duas mudanças sem interferência. A L21 só age com `spPortal`; a L22 só com `rfbSeg`. Nenhuma linha de uma toca a outra. Se o merge automático divergir disso, parar e reportar.
2. **Regeneração da identidade** (commit próprio): `node ops/anatomy/build-identity.mjs --write` e guarda da integração com os dois históricos. Prova: `050602a3`.
3. **Regeneração da baseline de 7 INs** (commit próprio): `official-lot-rfb.ts --write`, com o delta explicado por ato.

**Delta esperado do lote (prova), comparado ao #298:**

| Ato | Diferença | Causa |
|---|---|---|
| 108391, 115131, 133898, 141910 | Só `outputHash` | Identidade |
| 127905 (IN 2.121) | +1 `rfb_segment_type_conflict` | L22 (segmento 702 declarado `anexo`, texto do art. 137) |
| 104314 (IN 1.911) | annex 30→32; unidentified 17→15 (1.823→1.819 caracteres); `rfb_segment_type_unmapped` 2→0; `rfb_tachado_evidence` 17→15 | L22. Os 2 anexos declarados eram blocos não identificados tachados; agora são `annex` histórico, e a evidência específica de "não identificado tachado" deixa de ser necessária |
| 116968 (IN 2.021) | annex 56→60; unidentified 5→1 (160→103 caracteres); unmapped 4→0 | L22 |
| (portal SP) | art. 7º 103→0 | L21; nenhum efeito em RFB |

**Testes a repetir no candidato combinado:**
1. `tsc`; todos os `test/anatomy*.unit.test.ts` (prova: **317/317**), incluindo L21, L22, lote de 7 INs, L17, L14–L16 e L11;
2. `anatomy:verify-build`; snapshot sintético inalterado;
3. integração PG16 (prova: **12/12**);
4. SHA da saída do leitor por ato, igual ao do PR de origem de cada mudança: SP = #296; RFB = #297; as 5 INs sem L22 = #298;
5. CI completo no SHA unido. Falha conhecida do R7 (ONB-01 PG18), se ocorrer, documentada e sem nova execução;
6. revisão independente R2 do candidato.

**Execução:** só com decisão expressa.

## 15. L20 — complemento do desenho: citação que abrange os arts. 706 e 707 (só desenho; decisão de 06/11, #116 c.6673604188)

**Problema:** pelo §14.1(b'), a retomada no "sucessor numérico declarado sem aspas" falharia se a citação **legítima** abrangesse os arts. 706 **e** 707 e a fonte declarasse o 707 sem aspas. O 707 citado seria liberado como operativo.

**Evidência real que distingue os cenários** (somente leitura):
- **IN 2.121 (127905):**
  - 4005 = "Art. 705…" (`artigo`, não tachado);
  - 4006 = "Seção II…";
  - **4007 = "Art. 706…" (`artigo`, tachado)**, redação anterior do **próprio** art. 706;
  - **4008 = `"Art. 706…`** (999), mesmo texto, com aspa inicial solta e terminando com a mesma remissão legal do 4007.
  - É a nova redação do artigo do próprio ato, não uma citação de outro ato.
- **IN 2.021 (116968):** 677 = "…a Instrução Normativa RFB nº 971, de 2009, **passa a vigorar com as seguintes alterações:**" (tachado); 678 = `"Art. 142. …` (999). É uma citação legítima de **outro ato**, que fecha em 682.

**Critério complementar — "evidência suficiente de retomada"** (todas as condições; senão, `prohibited` é preservado):
- **E0:** as condições (a) e (b') do §14.1 valem (sem fechamento em todo o ato; sucessor N+1 declarado, sem aspas, não tachado).
- **E1 (artigo do próprio ato):** o segmento imediatamente anterior à abertura é um `artigo` **tachado com o mesmo número N** (redação anterior do próprio artigo). Sem isso, não há retomada.
- **E2 (sem introdução de alteração de outro ato):** nenhum dos segmentos entre o último artigo operativo e a abertura contém fórmula de alteração ("passa a vigorar", "com as seguintes alterações", "fica acrescido", "nova redação", "com a seguinte redação"). Havendo uma, a citação é de outro ato: **sem retomada**.
- **E3 (sucessor também do próprio ato):** se o sucessor N+1 for imediatamente precedido por um `artigo` N+1 tachado, isso reforça; sem esse par, a retomada só ocorre com E1 e E2 satisfeitas.
- **E4 (procedência):** E0–E3 são calculadas pela preparação a partir do JSON oficial (`rfbQuoteBounds`, com a evidência de cada condição) e entregues por referência com prova, como no §14.1(c). Nada vem de atributo HTML.

**Contracasos obrigatórios (sintéticos, modelados nos reais):**
1. **Citação de 706 e 707, com 707 declarado sem aspas, introduzida por "passa a vigorar com as seguintes alterações:"** (modelo IN 2.021): E2 falha. **706 e 707 continuam `prohibited`**, inclusive o 707 sem aspas.
2. **Mesma citação sem fórmula de introdução e sem 706 tachado antes da abertura:** E1 falha. **`prohibited` preservado.**
3. **Caso real IN 2.121** (4007 tachado = 706; 4008 abre `"Art. 706`; sucessor 707 em 4014): E0–E2 satisfeitas. Retoma no **707**; os §§ do 706 (4009–4013) continuam protegidos; limitação `rfb_quote_unclosed_bounded` com a evidência.
4. Abertura com aspas e fechamento em segmento posterior (IN 2.021, 678 → 682): (a) falha; **sem mudança**.
5. Plano `rfbQuoteBounds` forjado, copiado ou de outro HTML: ignorado (regra atual).

**Efeito esperado:** só a IN 2.121 muda entre os 7 atos do lote (a ser medido na implementação). IN 2.021 e IN 1.911: sem mudança. 🔴 A implementação depende de decisão expressa.

## 16. L20 — caso "706 tachado antes, sem fórmula de alteração, 707 sem aspas ainda dentro da citação" (só desenho; parecer COORD de 06/11)

**Problema:** E1 (706 tachado antes da abertura) e E2 (nenhuma fórmula de alteração reconhecida) podem ser satisfeitas **e** o 707 declarado sem aspas ainda estar dentro da citação. E0–E2 sozinhas **não distinguem** esse caso do caso real da IN 2.121. Pelo parecer, o resultado tem de continuar `prohibited` quando faltar evidência.

**Evidência real verificada (somente leitura, IN 2.121):**
- **E5 descartada:** o texto do segmento de abertura (4008), sem a aspa, **difere** do 706 tachado (4007): 383 × 368 caracteres. É uma nova redação, não uma cópia. A igualdade de texto não serve como prova.
- **E6, pares do próprio ato:** entre a abertura e o sucessor, os dispositivos aparecem em **pares tachado + vigente do mesmo dispositivo**: 4009 § 1º (tachado) / 4010 § 1º; 4011 § 2º (tachado) / 4012 § 2º. Esse é o padrão da consolidação multivigente **do próprio ato**; uma citação de outro ato não traz as versões tachadas do ato que cita.
- **E7, fechamento estrutural declarado:** imediatamente antes do sucessor há um **agrupamento declarado pelo ato** (4013 = `secao` "Seção III – Da Habilitação Definitiva"), sem aspas e não tachado. O sucessor 707 (4014) vem logo depois.

**Critério revisado (substitui a retomada do §15; todas as condições):**
1. E0 (§14.1: sem fechamento no ato; sucessor N+1 declarado, sem aspas, não tachado), E1 e E2 (§15);
2. **E6:** todo segmento entre a abertura e o sucessor é `paragrafo`/`inciso`/`alinea`/`item` em **par tachado + vigente do mesmo rótulo**, ou um agrupamento declarado (E7). Um único segmento fora desse padrão (999, rótulo sem par, artigo com número ≠ N) faz a regra **falhar**;
3. **E7:** o segmento imediatamente anterior ao sucessor é um **agrupamento declarado** (`secao`, `subsecao`, `capitulo`, `titulo`, `livro`, `parte`), sem aspas e não tachado, **ou** o próprio sucessor é precedido do seu par tachado (N+1 tachado + N+1 vigente);
4. **E4 (procedência):** E0–E7 calculadas pela preparação a partir do JSON oficial e entregues por referência com prova (§14.1(c)).

**Se qualquer condição falhar, todos os segmentos depois da abertura continuam `prohibited`** (regra atual), com a limitação `rfb_quote_unclosed_unresolved` indicando a condição que faltou.

**Contracasos obrigatórios (sintéticos):**
1. **Caso pedido pelo COORD:** 706 tachado antes da abertura; nenhuma fórmula; abertura `"Art. 706…`; §§ do 706 **sem** pares tachados; **707 sem aspas** logo em seguida, sem agrupamento entre eles. E6 e E7 falham. **706 e 707 continuam `prohibited`.**
2. O mesmo com um agrupamento declarado antes do 707, mas com §§ sem pares: E6 falha → `prohibited`.
3. O mesmo com pares tachados nos §§, mas sem agrupamento e sem o par tachado do 707: E7 falha → `prohibited`.
4. **Caso real IN 2.121** (4007 tachado; 4008 abre; 4009–4012 em pares; 4013 Seção III; 4014 Art. 707): todas as condições valem → retoma no 707; os §§ do 706 continuam `prohibited`.
5. Citação legítima multissegmento com fechamento (IN 2.021, 678 → 682): E0 falha → sem mudança.
6. Plano forjado, copiado ou de outro HTML: ignorado.

**Risco residual declarado:** uma citação de outro ato que reproduzisse **exatamente** os pares tachado + vigente do próprio ato **e** um agrupamento declarado antes do sucessor seria indistinguível pelos dados da fonte. Nesse caso, a limitação `rfb_quote_unclosed_bounded` registra a retomada e a evidência usada, para auditoria. 🔴 A implementação continua dependendo de decisão expressa.

## 17. L20 — desenho final: classificação inalterada; candidato a retomada só para revisão humana (parecer COORD de 06/11)

**Conclusão sobre E6/E7:** essas condições **ainda são compatíveis com uma citação legítima**. Um ato que transcreve outro pode reproduzir, **dentro da própria citação**:
- dispositivos em pares tachado + vigente (por exemplo, ao transcrever um trecho já consolidado);
- um agrupamento declarado ("Seção III…") antes do artigo seguinte;
- um artigo sucessor sem aspas, quando a fonte omite as aspas de abertura de cada bloco.

E0–E7 não excluem esses cenários. Pela regra do parecer, **`prohibited` é preservado em todos os casos**.

**Desenho final:**
1. **Classificação:** nenhuma mudança. Todos os segmentos depois de uma aspa aberta sem fechamento continuam `quoted_text`/`prohibited`, como hoje. **Não há retomada automática.**
2. **Candidato a retomada (só sinal):** quando E0–E7 (§14.1, §15, §16) forem todas satisfeitas, a preparação registra no plano provado um `rfbQuoteResumeCandidate` com:
   - o segmento de abertura e N;
   - o segmento do sucessor;
   - a evidência de cada condição (E1 artigo tachado, E2 sem fórmula, E6 pares, E7 agrupamento ou par).

   O leitor emite a limitação `rfb_quote_unclosed_resume_candidate`, com essa evidência, **sem alterar o contexto, o tipo ou a elegibilidade de nenhuma parte**. O resultado continua `partial`.
3. **Uso:** o candidato serve **apenas para revisão humana** (fila de revisão ou curadoria). Uma eventual decisão humana de retomada é outra etapa, com registro próprio, e **não** faz parte da L20.
4. **Procedência:** o candidato vem só do plano emitido pela preparação a partir do JSON oficial (objeto por referência, ligado ao SHA do HTML e ao `representationId`). Atributos HTML são ignorados; com plano ausente, forjado ou copiado, não há sinal.

**Efeito esperado:**
- IN 2.121: **nenhuma mudança** de partes ou de não identificado. Uma limitação `rfb_quote_unclosed_resume_candidate` com abertura 4008/N=706, sucessor 4014/707 e evidências E1, E2, E6 (4009/4010, 4011/4012) e E7 (4013 Seção III).
- IN 2.021 e IN 1.911: nenhuma limitação nova.
- As outras INs: inalteradas.

**Contracasos (o resultado é sempre `prohibited`; só varia a existência do sinal):**

| Caso | Partes | Sinal |
|---|---|---|
| 706 tachado + sem fórmula + 707 sem aspas citado, sem pares nem agrupamento | `prohibited` | não |
| Citação legítima que transcreve pares tachado + vigente e "Seção III" antes do 707 | `prohibited` | sim (revisão humana decide) |
| Caso real IN 2.121 | `prohibited` | sim |
| Citação com fechamento (IN 2.021, 678 → 682) | inalteradas | não |
| Plano forjado, copiado ou de outro HTML | `prohibited` | não |

**Teste de não regressão obrigatório:** o SHA da saída do leitor (partes, contextos, `sourceMap`) é idêntico antes e depois para os 7 atos. Só a lista de limitações pode ganhar o sinal.

🔴 A implementação (só o sinal, sem mudar a classificação) depende de decisão expressa.
