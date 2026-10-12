# F2-T03 — Anomalias e alertas da planilha (sem correção automática)

**Conferência:** 12/10/2026. Fontes recebidas: `taxonomia-v1_7_3-segmento(1)(2).xlsx` e `taxonomia-v1_7_0-produto(1)(2).xlsx`. Os hashes conferem com o manifesto antigo, mas novos arquivos corrigidos terão hashes novos e exigirão revisão do manifesto e do importador. Nenhuma fonte corrigida foi recebida nesta etapa.

## 5 anomalias bloqueantes (aba Produto)

| Linha Excel | Coluna | Valor atual (como armazenado) | Problema | Correção recomendada ao PO |
| --- | --- | --- | --- | --- |
| **333** | **D — NCM** | `9001.10, 8544.70` | Dois NCMs separados por vírgula, enquanto o formato multivalor desta planilha é `;`. | Confirmar ambos os códigos e usar `9001.10;8544.70` (não trocar os códigos sem validação). |
| **340** | **A — Segmento e B — Grupo** | **Ambos vazios**; item `Combustíveis gasosos obtidos por purificação`, código `product.ibge_35202020` | Produto sem vínculo hierárquico de curadoria; NCM atual `2711.21.00;2711.29.10;2711.29.90`. | Definir o **Segmento e Grupo** corretos; não herdar da linha 339. |
| **341** | **A — Segmento e B — Grupo** | **Ambos vazios**; item `Gás de carvão ou hidrocarbonetos líquidos`, código `product.ibge_35202010` | Produto sem vínculo hierárquico; NCM atual `2705.00.00`. | Definir o **Segmento e Grupo** corretos; não usar associação presumida pela posição. |
| **342** | **A — Segmento e B — Grupo** | **Ambos vazios**; item `Água natural`, código `product.ibge_36002010` | Produto sem vínculo hierárquico; NCM atual `2201.90.00`. | Definir o **Segmento e Grupo** corretos. |
| **3788** | **D — NCM** | Lista extensa com 27 tokens, terminada em `;Vazio` | `Vazio` não é código NCM; o importador deve recusar dados inválidos. | Confirmar que `Vazio` é sentinela e removê-la; preservar os códigos oficiais válidos, sem presumir correção jurídica. |

**Responsável pelas correções:** Fábio (planilha original). **Importador permanece estrito**, sem fallback, inferência de Segmento, limpeza silenciosa de NCM ou aceitação de sentinelas.

## 442 alertas — cardinalidade Produto × NCM na aba Segmento

Contagem a partir das colunas G `Produtos (sugeridos)` e H `NCMs (sugeridos)`, separando cada célula por `;`. Consideradas divergências **somente quando ambas possuem valores**.

| Tipo | Quantidade | Exemplo real | Classificação | Motivo |
| --- | ---: | --- | --- | --- |
| **Mais NCMs do que produtos sugeridos** | **368** | **Linha 4**, CNAE `0111-3/03`: **2** produtos (Trigo em grão, Trigo preto) e **3** NCMs (`1001.10.90;1001.90.90;1008.10.90`) | **ESPERADO** | Um produto/categoria pode sugerir múltiplas classificações; não associar por posição. |
| **Mais produtos do que NCMs sugeridos** | **74** | **Linha 13**, CNAE `0116-4/02`: **3** produtos (Girassol, sementes certificadas, sementes transgênicas) e **2** NCMs (`1206.00.10;1206.00.90`) | **ESPERADO** | Uma NCM pode ser relacionada a mais de uma descrição de produto; não associar por posição. |
| **Total** | **442** | | **Nenhum bloqueia isoladamente** | As listas independentes não formam pares posicionais. |

**Política:** aceitar `Produtos (sugeridos)` e `NCMs (sugeridos)` como **dois conjuntos distintos**. A cardinalidade diferente não deve criar erro de importação automaticamente, mas qualquer implementação que tente formar `produto[i] → ncm[i]` **é bloqueada**. Preservar o texto original, proveniência CNAE e marcas "sugeridos", exigindo curadoria para vínculos explícitos.

## Gates restantes

- Os **5 erros bloqueiam carga produtiva** até o PO corrigir os anexos, atualizar referência/hash e novo dry-run.
- **Sem correção automática** no importador, sem conversões legais implícitas.
- Nova planilha corrigida = **novo hash**; atualizar o manifesto `docs/reference-data/f2/README.md` e pins do importador **somente ao recebimento e verificação**.
- Carga produtiva apenas com **dry-run integrado + backup verificado + OK expresso de Fábio**, seguido da autorização CLAUDE-COORD para qualquer merge/deploy.

## Nova auditoria da regra NCM — fonte v1.7.0 (12/10/2026)

A regra pedida agora aceita **2/4/6/8 dígitos, com pontos opcionais**, e proíbe caracteres além de dígitos e pontos **em cada token NCM do campo Produto**, dividido por `;`. Ao aplicar essa regra estrita offline à antiga Produto v1.7.0, foram detectadas **seis anomalias adicionais até então mascaradas pela normalização permissiva**. Nenhum dado foi corrigido automaticamente:

| Linha | Coluna | Valor antigo | Problema |
| ---: | --- | --- | --- |
| 31 | D (NCM) | `0201, 0202` | Dois códigos separados por vírgula |
| 34 | D (NCM) | `1601, 1602` | Dois códigos separados por vírgula |
| 43 | D (NCM) | `61, 62` | Dois capítulos separados por vírgula |
| 81 | D (NCM) | `8541, 8542` | Dois códigos separados por vírgula |
| 166 | D (NCM) | `3003, 3004` | Dois códigos separados por vírgula |
| 180 | D (NCM) | `2504, 3801` | Dois códigos separados por vírgula |

**Correção sugerida:** Fábio confirmar a identidade de cada código e, se forem de fato dois NCMs válidos, separar com `;`, preservando 2 ou 4 dígitos quando aplicável. **Não contornar no importador.** As seis ocorrências são adicionais às cinco anteriormente identificadas, totalizando **11 ocorrências na versão v1.7.0 sob a validação nova**. Não afirmar que persistem na v1.7.1 sem acesso ao arquivo corrigido.

**Segmento v1.7.3, coluna H:** 18 entradas igualmente contêm valores concatenados por vírgula, mas a coluna é explicitamente `NCMs (sugeridos)` e permanece **texto sugestivo sem conversão em vínculo NCM oficial no T03**. Essas sugestões só poderão virar carga estruturada após curadoria e validação separadas.

**422? Não:** os alertas de cardinalidade seguem **442 = 368 + 74**, todos ESPERADOS e aceitos. Nenhum pareamento produto×NCM por posição.
