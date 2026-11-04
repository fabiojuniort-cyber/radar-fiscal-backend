# ANAT-D03: diagnóstico dos blocos não identificados e proposta para os tachados

Pedido pelo COORD depois do aceite técnico R2 (#279 @ `103639d8`). **É só diagnóstico e proposta: nada foi implementado.** As mudanças de classificação abaixo dependem de decisão expressa do Fábio. Leitor desta branch: anterior ao STRUCT. Fonte: os 4 JSON oficiais da RFB coletados.

## 1. Blocos `unidentified` por causa (caracteres)

| Causa | IN 2.237/2024 | IN 2.005/2021 | IN 2.162/2023 | IN 1.932/2020 | Origem |
|---|---|---|---|---|---|
| Inciso sem travessão ("I que…") | **11.279** (85 blocos) | 0 | 0 | 0 | O portal omite o separador, que só é desenhado na exibição. A gramática exige `I –`. |
| Agrupamento (CAPÍTULO, SEÇÃO…) | 602 (15) | 781 (22) | 0 | 0 | O leitor desta branch não tem `group`. O STRUCT-01 (#280, já aceito) reconhece isso, e a contagem cai na pilha integrada. |
| Ementa | 78 | 209 | 480 | 300 | O segmento de ementa (`idTipoSegmento` 1) chega sem marcador. |
| Nome do signatário | 31 | 25 | 31 | 25 | Linha de assinatura sem marcador. |
| Item "1." em contexto não previsto | 281 (2) | 0 | 0 | 0 | Item fora de alínea; o STRUCT-01 cobre parcialmente. |
| **Total** | **12.271** | **1.015** | **511** | **325** | |

Nenhum texto se perde: tudo é contabilizado (cobertura 100%). A perda é de **estrutura**.

## 2. Propostas (🔴 aguardam decisão do Fábio)

### P1. Inciso sem travessão no JSON da RFB
- **AS IS:** 85 incisos da IN 2.237 ficam `unidentified`.
- **TO BE:** na preparação RFB, usar o **tipo de segmento declarado pelo próprio portal** (`idTipoSegmento`, cuja tabela vem em `tiposSegmento` no mesmo JSON) como evidência estrutural. O tipo fica gravado como atributo do bloco, sem inserir texto. O leitor reconhece o inciso pelo tipo declarado, e não por um travessão inventado.
- **Impacto:** muda a preparação e o leitor para a fonte RFB (identidade do motor). O texto continua idêntico.
- **Alternativa:** manter como está e declarar a limitação.

### P2. Tachados (redação superada) na visão multivigente
- **AS IS:** segmentos `tachado: true` entram como texto comum. O vínculo os recusa, mas a anatomia não os distingue.
- **TO BE:** a preparação grava a marcação de origem (`data-rfb-tachado`, com o ponteiro JSON), e o leitor atribui contexto `historical`, com o motivo `rfb_tachado_source`, só com essa evidência. **Sem inferir vigência:** `legalStatus` continua `unknown`.
- **Impacto:** muda a preparação e o leitor (identidade do motor). Em compensação, a anatomia deixa de apresentar redação riscada como operativa.
- **Alternativa:** manter só a recusa no vínculo.

### P3. Ementa e assinatura
O texto já está contabilizado. Reconhecer esses blocos pelo tipo de segmento do portal, como na P1, é opcional e de baixo impacto. A recomendação é tratar junto com a P1, se a P1 for aprovada.

**Recomendação do EXEC:** aprovar P1 e P2 juntas, numa entrega própria com revisão. Até lá, as 4 INs ficam `promoted:false`.
