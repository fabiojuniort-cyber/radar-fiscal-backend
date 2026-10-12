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
