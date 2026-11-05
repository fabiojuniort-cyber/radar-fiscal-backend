# ANAT COLETA-02 — coleta finita do §8 da STATUS-MATRIX-02 (05/11/2026)

**Autorização:** COORD (#293 c.6665613398) e Fábio ("executar a coleta finita dos 6 itens do §8… respeitando os limites publicados"). Coleta só por `consultOfficial` (hosts oficiais, HTTPS, redirecionamentos validados, JSON RFB validado pela D03). Todos **`promoted:false`**, `urlStatus:candidate`, `verified:false`. Nenhum id ou chave reservada; sem corpus, gold ou reserva; nenhum desafio ou recusa de rede contornado. Sondagens de triagem (curl, não versionadas) foram descartadas.

**Base:** ramo do #294 @ `871ed557` (candidato composto). Os atos RFB novos ficam em `rfb-normasinternet2-coleta02/`, para **não** alterar o lote de regressão aprovado (#289); incluí-los no lote é decisão à parte.

## Snapshots coletados

| id | URL oficial | Consultado em (UTC) | Bytes | SHA-256 | promoted |
|---|---|---|---|---|---|
| 104314 (IN RFB 1.911/2019) | normasinternet2…/ato/104314/visao/multivigente | 2026-11-05T18:21:58Z | 2.285.257 | `9005fddbc2df67e3…` | false |
| 116968 (IN RFB 2.021/2021) | normasinternet2…/ato/116968/visao/multivigente | 2026-11-05T18:21:59Z | 787.461 | `4ca8d1d3179f3230…` | false |
| ricms-an1art041 (RICMS, An. I art. 41) | legislacao.fazenda.sp.gov.br/Paginas/an1art041.aspx | 2026-11-05T18:22:00Z | 199.138 | `ae7aaccb5dde4606…` | false |
| ricms-an2art003 (RICMS, An. II art. 3º) | …/Paginas/an2art003.aspx | 2026-11-05T18:22:01Z | 176.447 | `fd16792a05c9f20a…` | false |
| ricms-art008 (RICMS, art. 8º) | …/Paginas/art008.aspx | 2026-11-05T18:22:01Z | 156.994 | `992acb77fa739bb7…` | false |
| ricms-art009 (RICMS, art. 9º) | …/Paginas/art009.aspx | 2026-11-05T18:22:01Z | 154.921 | `12b04f67c9b81d6e…` | false |

SHA completo, URL, cadeia de redirecionamento, `lastModified` e (RFB) identificação e preparação capturada estão em cada `*.meta.json`. Script reprodutível: `ops/anatomy/collect-02.ts`.

## Resultado por item (motor do candidato #294, identidade `afb275ec`)

| # | Lacuna | Consultas usadas / limite | Resultado |
|---|---|---|---|
| 1 | L11 (`parte` em 2º ato) | 10 / 10 (ver inventário) | **IN 1.911/2019** declara 6 PARTEs: **todas reconhecidas** como `group` nível `part`. Há 15 segmentos 999 (limitação), 30 conflitos de tipo × gramática (gramática mantida) e 2 limitações `rfb_segment_type_unmapped` |
| 2 | L20 (aspas em segmento 999) | 1 (busca compartilhada) | **IN 2.021/2021**: 20 segmentos 999 começam com aspas. Ficam `quoted_text` 68 blocos (12.409 caracteres, **8,2%**), com sequência máxima de 39 blocos. **Não** chega ao fim do ato como na IN 2.121. O padrão se repete, com efeito menor |
| 3 | L13 (limite de 2 MiB) | 0 extra (metadados das sondagens) | HTML preparado / limite: **IN 2.121 = 88%** (o "92%" registrado antes usava 2 MB decimais; corrigido), IN 1.911 = 57%, IN 2.110 = 39%, IN 1.700 = 32%, IN 2.021 = 11%, IN 2.161 = 10%. **Nenhum ato ultrapassa** o limite |
| 4 | L2/L12 (anexos RFB) | 1 verificação (JS do portal) | Na IN 2.121, **1 de 31** anexos vem **embutido no JSON** (`arquivoBinario.arquivoBinario`, HTML em base64, 5.643 bytes, tipo 5). Os outros 30 são PDFs (tipo 6) **sem conteúdo no JSON** e sem endpoint oficial identificado. Nenhum anexo foi coletado |
| 5 | L18 (`blockquote`) | 4 sondagens / 2 páginas | An. I art. 41: 25 `revogado` em `blockquote`; An. II art. 3º: 7. Pelo motor, 74 e 22 blocos `quoted_text`/`prohibited`, mantidos (L18 adiada). Amostras disponíveis para a decisão futura |
| 6 | L21 + regressão L14–L17 | 2 páginas | art. 8º e art. 9º: não identificado bruto ~18.000 → **1 e 0** caracteres pelo portal com prova. U+200B não bloqueou nenhum bloco nas 4 páginas novas |

**Portal SP (4 páginas, `SEFAZ-SP-PORTAL` com prova):**

| Página | Não identificado (bruto → portal) | Notas | Históricos | Citação/proibido |
|---|---|---|---|---|
| An. I art. 41 | 17.858 → 70 | 1 | 33 | 74 |
| An. II art. 3º | 18.700 → 71 | 5 | 43 | 22 |
| art. 8º | 18.175 → 1 | 5 | 4 | 7 |
| art. 9º | 17.642 → 0 | 1 | 2 | 0 |

Elegibilidade positiva: 0. `legalStatus` `unknown` em todas as partes dos 6 atos.

## Lacunas novas ou atualizadas
- **L2/L12 (atualizada):** "anexo sem conteúdo" vale para os PDFs. O anexo HTML embutido **existe no JSON** e hoje não é lido pela preparação. Lê-lo mudaria a preparação RFB: **depende de decisão**.
- **L13 (corrigida):** 88% (não 92%).
- **L20 (recorrência):** também ocorre na IN 2.021, com efeito de 8,2%.
- **L22 (nova):** segmentos declarados `anexo` pela RFB (30 na IN 1.911, 35 na IN 2.021) não estão no mapa de tipos. Quando a gramática não reconhece "ANEXO", sai a limitação `rfb_segment_type_unmapped` (2 e 4 casos). Mapear seria mudança de gramática: **depende de decisão**.

## Efeito sobre E9 (cobertura oficial)
A amostra oficial passa a ter **RFB 7 INs** (pequeno → muito grande) e **Sefaz-SP portal 6 páginas** (artigos e anexos). Continuam ausentes: Planalto, CONFAZ, DOU e DOE-SP diário (dependem de M1–M5 e M9). Sem pontuação; a avaliação de E9 é do COORD.

## Inventário das consultas (pedido do COORD, #295 c.6671591751)

**O script reproduz só a captura dos 6 alvos.** A triagem que levou à escolha deles foi feita antes, com `curl`, e seus corpos foram descartados (não versionados). Inventário completo dessa triagem, contada nos limites por item:

| # | Host | Requisição | Finalidade | Conta no limite de |
|---|---|---|---|---|
| T1 | normas.receita | POST pesquisar `{"termo":"parte"}` e `{"termoBusca":"parte"}` | Descobrir o formato da busca (sem resultado útil) | Nenhum item (descoberta da API) |
| T2 | normas.receita | POST pesquisar ×3 (`termoBusca`, variações de página) e ×8 (variações de tamanho de página) | Descobrir a paginação (sem resultado útil) | Nenhum item (descoberta da API) |
| T3 | normas.receita | GET `/` e `main-*.js` | Ler o formato da busca no JS público | Nenhum item (descoberta da API) |
| T4 | normas.receita | POST pesquisar "consolida" (5 resultados) | Validar o formato descoberto | Nenhum item (descoberta da API) |
| 1.1 | normas.receita | POST pesquisar "consolida as normas" (IN, vigentes) | Candidatos | Item 1 (1/10) |
| 1.2–1.3 | normasinternet2 | GET JSON 126687 e 116968 | Tipo `parte`? (116968 serviu ao item 2) | Item 1 (3/10) |
| 1.4–1.5 | normas.receita | POST pesquisar "Parte Geral" e número 1700 | Candidatos | Item 1 (5/10) |
| 1.6–1.7 | normasinternet2 | GET JSON 133782 e 81268 | Tipo `parte`? (81268 também deu o tamanho do item 3) | Item 1 (7/10) |
| 1.8 | normas.receita | POST pesquisar "Parte Especial" | Candidatos | Item 1 (8/10) |
| 1.9–1.10 | normas.receita / normasinternet2 | POST pesquisar número 1911 + GET JSON 104314 | Achado: 6 PARTEs | Item 1 (**10/10**; o registro anterior dizia 9, ao contar busca e JSON como uma só) |
| 4.1 | normasinternet2 | GET `/` e `main.*.js` | Endpoint de anexo (não encontrado) | Item 4 (1 verificação, com 2 requisições) |
| 5.1–5.4 | legislacao.fazenda.sp.gov.br | GET an1art041, an2art003, an2art018, an1art015 | Contar `revogado` em `blockquote` | Item 5 (4 sondagens; 2 escolhidas) |

As capturas versionadas (6) foram feitas **depois**, pelo `collect-02.ts`, e repetem o GET dos 6 alvos. Os 4 GETs de triagem de alvos não escolhidos (126687, 133782, 81268, an2art018/an1art015) **não** foram versionados; seus números (tamanho, tipos) estão no relatório como metadados de triagem. Correção: o item 1 usou **10/10** consultas (o limite foi atingido, não excedido). O script agora termina com código ≠ 0 se algum alvo falhar, e imprime `captured N/6`; o código de saída sozinho não é gate de aceite.
