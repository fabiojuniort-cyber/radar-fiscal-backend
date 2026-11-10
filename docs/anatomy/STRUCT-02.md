# ANAT-STRUCT-02 — caput, parágrafo único, cabeçalho de publicação e rodapé

Governança: tribusca-control#116 (decisão 7 do comentário 6542971547). Empilhado sobre o ANAT-STRUCT-01 (#280). Lote só com fixtures sintéticas.

## O que muda

| Item | Implementação | Compatibilidade |
|---|---|---|
| **Caput** | Cada `article` e cada `clause` ganha um filho `caput` sobre **exatamente** o bloco de abertura. Id derivado: `<id do artigo>-caput`. Fica em primeiro na ordem dos irmãos e herda o contexto do artigo. | Os ids sequenciais (`part-N`) agora excluem os caputs, então **nenhuma outra parte é renumerada**. O caput **não** é dono de entidades (`entities.ts` o exclui) nem gera elegibilidade (`engine.ts` o exclui). Na tela de configuração fica oculto, porque o texto já aparece como passagem do artigo. |
| **Parágrafo único** | Continua `paragraph`, com o motivo `paragraph_sole` em vez de `paragraph_marker`. A palavra precisa estar inteira, com fronteira Unicode e em qualquer caixa. | Não muda tipo, contexto nem aninhamento. Uma menção em prosa ("o parágrafo único do art. 2º") não vira parágrafo. |
| **Cabeçalho de publicação (`publication_header`) e rodapé (`footer`)** | **Não implementados neste lote.** Os marcadores dependem do layout real de cada portal (DOU, DOE-SP, Receita, CONFAZ). Sem acesso às fontes oficiais, qualquer padrão seria inventado. | **BLOQ (rede).** Proposta: campo de perfil `blockStarts.publicationHeader`/`footer`, vazio por padrão e preenchido só depois da homologação com originais oficiais (OFFICIAL-01). |

## Delta medido nos artefatos congelados (conferido antes de regravar)

- **`synthetic-equivalence.json`:**
  - 19 caputs acrescentados;
  - 11 deslocamentos de `order` entre irmãos, porque o caput passa a ser o primeiro filho;
  - 1 `Parágrafo único` com o motivo `paragraph_sole`;
  - **entidades e elegibilidade idênticas**; nenhuma outra parte mudou.
- **`unicode-b2-nfc-equivalence.json`:** 1 caput por documento. Fora isso, os 3 documentos ficaram iguais ao congelado (comparados sem os caputs e sem a ordem).
- **`profile-engine` #249 R2/B:** a lista de partes ganha o caput da cláusula, com comentário.
- **Identidade do motor:** `0481229a…` → `08d04628…`, com `--write`. A guarda da `base-migration` foi atualizada.

## Testes

`test/anatomy.struct2.unit.test.ts` (5 testes) cobre:
- caput por artigo e por cláusula, com span, ordem, id e contexto histórico;
- posse das entidades, elegibilidade e ausência de renumeração;
- `Parágrafo único` × `§ 1º` × menção em prosa, inclusive em caixa alta;
- fidelidade, com Unicode e emoji, e a cobertura.

Resultado com Node 24: 177/177 nas suítes ANAT sintéticas.

## Limitações

- ANAT-D02 (decidido pelo Fábio: corrigir): o caput cobre o bloco de abertura **e** os blocos seguintes sem marcador, até o artigo receber outro filho (§, inciso, tabela, nota). Os blocos de continuação ficam aninhados sob o caput (motivo `caput_continuation`, um ponteiro de origem por bloco). Snapshots sintéticos sem delta; identidade do motor 4f3256e6 → da144681.
- `publication_header` e `footer` continuam bloqueados pela rede (ver acima).
