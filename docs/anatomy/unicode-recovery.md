# ANAT-UNICODE-01b/B2 — recuperação NFC integrada ao motor

Origem: [autorização do COORD na issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6315618204), sobre a [proposta B2](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6315109262). Base: #252 em `317d177` (B1, PASS técnico).

**Escopo:**
- O pacote integra ao leitor, à identificação de colunas e ao extrator a sombra NFC e o mapa revisados no B1.
- A saída pública continua no contrato v1, sem campos novos. `contract.ts` não mudou.
- Documento recuperado continua `partial` e **sem seleção positiva**.
- Nada foi implantado. Os testes usam só dados sintéticos e dados técnicos Unicode.

## Política de execução

| Situação | Caminho | Resultado |
|---|---|---|
| Texto, representação e atributos decodificados em NFC | **Caminho NFC atual**, sem sombra | Saída estrutural igual à anterior; mudam só `engineHash`, `analysisId` e `outputHash` |
| Texto canônico fora de NFC, atributos decodificados em NFC, runtime Unicode 17.0, sombra utilizável com **todas** as fronteiras de `sourceMap` forçadas e todos os spans exatos | **Recuperação** | Os casadores usam a sombra; partes, células e entidades são publicadas nas posições e literais originais. Sai `partial` com `non_nfc_text` (diagnóstico) e `nfc_shadow_matching` |
| Atributo decodificado fora de NFC (literal, `&#769;`, `&#x301;`) | Quarentena (opção A) | `non_nfc_text`, sem entidades |
| Só a marcação ou representação fora de NFC, com texto canônico em NFC | Quarentena (fora do escopo) | `non_nfc_text`, sem entidades |
| Fronteira insegura entre nós (L\|V, LV\|T, acento ou reordenação entre nós), invariante quebrada ou mapeamento recusado | Quarentena | `nfc_shadow_unusable` |
| Runtime com outra versão Unicode | Quarentena (falha fechada) | `unicode_runtime_unsupported` |
| Span de parte, entidade, operador, condição ou escopo alargado ou inexato, mesmo descoberto tarde | Quarentena da **extração inteira** | `nfc_span_widened`; entidades e relações vazias, nunca "códigos sem a exceção" |

**Em toda quarentena:**
- o resultado final tem entidades e relações vazias, nenhuma entrada de elegibilidade NCM e nenhuma seleção positiva;
- texto, estrutura e demais limitações continuam disponíveis;
- a mensagem diz que a extração não foi feita.

**Na recuperação:** a mensagem de contenção do 01a ("extração não realizada") é substituída, porque deixa de ser verdadeira. As demais limitações, como recursos ausentes, conteúdo não identificado e geometria, são calculadas normalmente.

**Validações existentes continuam valendo:** falhas do caminho Unicode não escondem perfil inválido, piso de proteções ou requisição inválida. Esses erros continuam recusados como antes.

## Responsabilidades e arquivos

- **`nfc-recovery.ts` (novo):**
  - decide entre recuperação e quarentena (função pura; não registra nada);
  - oferece o mapeamento exato ida e volta, que gera `NfcQuarantineError` quando o span não é exato.
- **`readers.ts`:**
  - é o **único** lugar que registra o contexto de recuperação: um `WeakMap` privado, sem setter exportado, cuja chave é o próprio objeto de resultado do leitor. A API exportada não permite anexar contexto ou mapa a um resultado que o leitor recusou (correção B2-R1-01). Isso **não** é fronteira de segurança contra código malicioso no mesmo processo;
  - depois de montar `canonicalText` e `sourceMap`, e antes de qualquer casador, decide a recuperação forçando todas as fronteiras de `sourceMap` e conferindo cada span de `sourceMap` como exato;
  - na recuperação, `describe` e o rastreio de aspas leem cada bloco pela sombra, montada nó de texto a nó de texto;
  - estrutura, spans, rótulos (`label`) e atributos continuam originais;
  - `identifyNcmPartIds` lê os cabeçalhos pela sombra quando o resultado tem contexto;
  - nos caminhos de fallback (texto puro, limites), a decisão é tomada no envoltório.
- **`entities.ts`:**
  - `extractAnatomyEntities`, a função pública, **continua recusando texto não NFC**;
  - `extractRecoveredEntities` só funciona com o contexto do leitor. Ela:
    - mapeia as partes para a sombra (exigindo exatidão) e extrai na sombra;
    - devolve cada entidade ao original (exata), confere que a parte dona ainda a contém e recalcula os IDs pelas posições originais, sem duplicata;
    - **confere os proprietários atravessados** (correção B2-R1-02): os spans de entidade, operador e condição só podem atravessar partes que os contêm ou partes com o mesmo contexto do dono e de tipo permitido. Atravessar assinatura, histórico, epígrafe, ementa, preâmbulo, citação, conteúdo não identificado etc. leva à quarentena integral (`nfc_shadow_unusable`);
    - remapeia `groupId` e `targetEntityIds` sem deixar referência pendurada;
    - confere a exatidão dos spans internos de operador e condição.
- **`engine.ts`:** com contexto, usa `extractRecoveredEntities`. Qualquer `NfcQuarantineError` descarta toda a extração e publica o motivo. Sem contexto e com `non_nfc_text`, mantém a quarentena do 01a.

**Relações e campos (contrato v1 sem mudança):**

| Campo | Origem na recuperação |
|---|---|
| `span`, `literal` | Posição e fatia **originais** |
| `normalized` | Domínios NCM: dígitos (iguais). Composto de exceção: `marcador NFC em minúsculas:alvo` (derivado). **Demais domínios** (citação, processo, receita etc.): literal original. Identificadores nunca são normalizados; zeros e catálogo preservados |
| `relation.operator` | Forma NFC da sombra (derivado) |
| `relation.condition` | Fatia **original** de um intervalo exato, ou `null` quando não há condição |
| Spans de operador, condição e escopo | Metadados **internos** (`WeakMap`), não publicados; o v1 não ganha `operatorSpan` nem `scopeSpan` |

**Adaptador e avaliador:**
- sem mudança de semântica: carregam `partial` e os diagnósticos;
- um operador em NFC que não aparece literalmente no literal NFD fica com `operatorSpan: null` e pendência `operator_span`, sem adivinhar span nem dar crédito.

**Escopo da evidência:** reconhecimento e posições apenas. Não cria CURRENT_ATTESTED, vigência nem seleção jurídica.

## Identidade

- `build-identity.mjs` passou a incluir `nfc-recovery.ts`, `nfc-shadow.ts`, `nfc-shadow-table.ts` e `docs/anatomy/nfc-shadow-manifest.json` (versão Unicode 17.0.0 e hashes dos arquivos UCD).
- **`engineHash`: `bbcd7a7c…` → `b6ccf583621e647e6861204dfa7a2761afe801a3a2173dedc1abdd025d9bf918`**, regenerado com `--write` e verificado. O valor final está em `docs/anatomy/engine-build.json`.
- `analysisId` e `outputHash` mudam para todos os documentos, inclusive os NFC.
- Não há download em runtime.

## Testes (só sintéticos; Node 24, Unicode 17.0)

Arquivo novo `test/anatomy.unicode-recovery.unit.test.ts`, incluído em `test:anatomy`:

| Caso | Resultado | Teste |
|---|---|---|
| Cláusula, preâmbulo, retificação, citação + código de receita, cabeçalho NCM, faixa com "até", exceção "excluída" e documento misto em NFD | **Recuperado**: igual ao equivalente NFC (partes, contextos, domínios, relações, operador e condição comparados em NFC), contrato válido, `partial`, zero positivo | `recovery of clause…` |
| `sourceMap`, spans, literais e hashes originais; entidades após emoji/ZWJ e reordenação; condição como fatia original; operador em NFC; IDs sem pendência | Recuperado e exato | `original sourceMap, spans…` |
| L\|V, LV\|T, acento e reordenação entre nós | Quarentena `nfc_shadow_unusable` | `whole-document quarantine…` |
| Atributo NFD literal, decimal e hexadecimal; só atributo | Quarentena `non_nfc_text` | idem |
| Entidade alargada (código seguido de marca sem composição) | Quarentena `nfc_span_widened` | idem |
| Operador alargado, descoberto depois do mapeamento dos códigos (erro tardio) | Quarentena da extração inteira | idem |
| Citação recuperada atravessando assinatura (DOU) ou bloco histórico (CONFAZ) | Quarentena integral `nfc_shadow_unusable` | `B2-R1-02…` |
| Travessias compatíveis (nós inline de um bloco) | Recuperado, igual ao NFC | idem |
| Contexto anexado por chamada exportada a documento recusado (atributo NFD) | Impossível: não há setter; o extrator recusa | `B2-R1-01…` |
| Condição ou escopo inexatos | Começam no operador e terminam numa entidade ou no fim de uma parte, então qualquer inexatidão passa pelos casos acima | idem |
| Runtime Unicode 16.0 (simulado) | Quarentena `unicode_runtime_unsupported`; documento NFC inalterado | `incompatible runtime…` |
| NFC com `q́`, surrogate isolado + marca, emoji ZWJ | Igual à saída do motor pré-B2 (`317d177`, fixture `unicode-b2-nfc-equivalence.json`); sem contexto de sombra | `NFC path never uses the shadow…` |
| Extrator direto com texto não NFC; cópia ou objeto forjado; opção de requisição extra; perfil abaixo do piso | Recusados | `no bypass…` |
| Adaptador e avaliador | `partial`, `nfc_shadow_matching`, operador sem span adivinhado | `adapter and evaluator…` |

**Testes já existentes atualizados**, só onde a recuperação foi autorizada:
- `anatomy.unicode` (01a): exceção NFD, documento misto, casos de borda e preservação de hashes passam a ser **recuperados**. Os casos residuais continuam em quarentena: atributos e marcação.
- `anatomy.profile-engine` (#249 R2/B): a cláusula NFD passa a ser reconhecida. A comparação dos casadores com as regras originais continua igual.
- `anatomy.nfc-shadow` (B1): o teste de isolamento passou a verificar o acesso só via `nfc-recovery` e a inclusão na identidade.

**Não alterados:** snapshot dos 12 sintéticos, oráculo, golds, especificações e aprovações. Dos 9 adversariais do #249, os 7 em NFC continuam idênticos ao motor anterior; os 2 em NFD passam a ser recuperados.

**Exemplos de diagnóstico:** ver o handoff na issue #116.
