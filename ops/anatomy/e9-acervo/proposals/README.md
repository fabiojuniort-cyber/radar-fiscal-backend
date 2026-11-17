# E9 P2-c: continuidade (2026-11-11). Propostas offline, nada integrado

COORD → EXEC, continuidade P2-c (tribusca-control#116). Tudo aqui é **offline**: nenhuma requisição foi feita, nenhum grant
foi ativado e não houve merge. Os patches são propostas para revisão independente; nenhum foi aplicado num PR de Anatomia.

Bytes usados: os preservados no #303 @ `719352f`, em `ops/anatomy/official-identification/rfb-p2c/`:

| idAto | ato | SHA-256 |
|---|---|---|
| 148693 | Portaria RFB 635/2025 | `a98ade77b2ba…` |
| 148629 | ADE Cofis 30/2025 | `cc3c7a1f3e77…` |
| 148516 | ADE Corat 33/2025 | `0c8788185864…` |
| 148681 | SC Cosit 258/2025 | `d74c8f46b782…` |

## A. ADE Cofis 30/2025 × #300 (anexo HTML embutido)

O #300 (`22e8cc48`, motor `04af1bfd`, PASS técnico offline 06–07/11) foi testado sobre os bytes preservados.

- **Estado no #300 sem alteração:** `not_html`.
  - O anexo (id 82381, `idTipoArquivo` 5, 3.308 bytes, SHA `f857a997c886da99…`) é um **fragmento** `<table …>`, sem `<html>`/doctype e sem declaração de charset.
  - Depois do `not_html`, cairia em `charset_undeclared`.
  - O payload é UTF-8 estrito e válido.
- **Contexto do segmento de referência:** `prohibited`. O segmento #3 (`Anexo`) não tem texto nem tachado, e a regra R3 do #300 o trata como indeterminado. Ele fica entre o Art. 1º, que termina em "de acordo com as especificações descritas abaixo.", e o Art. 2º.
- **Protótipo** (`prototype-300-fragment.patch`, +6/−4):
  - aceita um fragmento `<table>` quando o tipo é 5;
  - com charset ausente, decodifica UTF-8 estrito e marca o caso no `reason`.
  - **Resultado:**
    - `read`, com 803 caracteres;
    - 1 tabela, 9 linhas e 16 células;
    - 0 limitações;
    - **26/26 ponteiros de origem** decodificam exatamente dos bytes base64 originais;
    - SHA do payload igual.
  - O teste do #300 continua 10/10.
  - **Mesmo lida, a tabela fica `prohibited`** pela regra R3.
- **Conclusão:** não falta só integrar. Há três decisões:
  1. aceitar fragmento tabular (`idTipoArquivo` 5) como anexo HTML;
  2. charset não declarado com UTF-8 estrito: a evidência é inferida e precisa de decisão explícita;
  3. a regra R3 dá `prohibited` a um anexo sem texto entre dispositivos operativos. Mudar isso altera um contrato já aprovado no #300 (decisão do COORD).
- **Preâmbulo:** continua `unidentified`. A fonte o classifica como `Não Identificado` (D04); a preparação principal não muda no #300.
- **Integração no #303 (merge de teste local, sem push):**
  - **Dependência:** o #300 é base comum (`3f7564e4`) mais 4 commits; o #303 tem 30 commits além dessa base.
  - **Conflitos:** 6. Quatro são gerados ou de identidade e se resolvem regenerando: `engine-build.json`, `official-lot-rfb.json`, `build-identity.ts` e o pin do teste base-migration. Dois são de código e se resolvem por união: imports em `official-lot-rfb.ts` e a lista de `build-identity.mjs`.
  - **Resultado:** `tsc` limpo; `test:anatomy` 340/340; teste do #300 10/10. Esse teste **não** está na lista `test:anatomy` e precisa entrar nela.
  - **Motor:** `0e009431 → a06a8e17`.
  - **Lote:** muda só `inlineAttachments` e o `outputHash`; status e caracteres são iguais nos 4 atos.
  - **Consequência:** o aceite da Portaria fixado em `0e009431` precisaria de novo registro append-only no motor composto, como foi feito com as leis no #309.

## B. ADE Corat 33/2025: Anexo Único externo

- **Corpo lido:** 18 artigos, 12 parágrafos e 17 incisos. Não identificado: preâmbulo (segmentos #2 e #3, `Não Identificado` pela fonte, 262 caracteres).
- **0 anexos** no JSON. O ato remete para fora:
  - Art. 17: "O Anexo Único deste Ato Declaratório Executivo será publicado na Internet, no endereço eletrônico da RFB <( https://www.gov.br/receitafederal )>."
  - Art. 1º, § 3º (segmento #10): "A Agenda Tributária será disponibilizada na página da RFB na Internet…".
- **Completude:** o corpo normativo está completo; o Anexo Único (calendário de janeiro de 2026) **não** está na representação oficial do ato. A norma integral não é aceita.
- **Plano de obtenção (não executado):**
  1. **URL:** o ato só dá a raiz `https://www.gov.br/receitafederal`. É preciso 1 descoberta para a página exata da "Agenda Tributária — janeiro de 2026", mais 1 captura e os redirecionamentos.
  2. **Host:** `www.gov.br` está fora de `OFFICIAL_HOSTS.RFB`; exige autorização própria e uma rota presa ao caminho achado.
  3. **Orçamento:** máximo de 3 requisições (descoberta, captura e 1 redirect), num grant próprio. Não é o saldo ADE do G1, porque é outro host e outro recurso.
  4. **Proveniência:** URL inicial e final, Content-Type, SHA-256, data da captura, e o vínculo `rfb:148516:anexo:externo` com o Art. 17 como evidência de remissão.
  5. **Validação:** a página precisa dizer "janeiro de 2026" e "Agenda Tributária"; recusar mês ou ano divergente; ler como recurso separado (como no #300), nunca dentro do ato.

## C. SC Cosit 258/2025: corpo em PDF ausente

- **O que o JSON traz:**
  - duas ementas: a #1 **tachada** cita o "inciso XI" do art. 6º da Lei 7.713/1988; a vigente cita o "inciso XV";
  - o rótulo "SC Cosit nº 258-2025";
  - o fecho.
- **O que falta:** o texto principal está no **PDF id 83325** (`idTipoArquivo` 6, `SC Cosit nº 258-2025.pdf`, `arquivoBinario` null). O id 82416 é a versão anterior tachada do PDF. URL que o conector monta: `https://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=83325`.
- **No #300:** os dois anexos ficam `missing_no_content`.
- **Ementas no #303:** as duas são `summary`/`prohibited`, **sem distinção de versão**. A tachada precisa sair como histórica.
- **Preparação de PDF reutilizável:** **existe**, ANAT-PDF-01 `readPdfInput` (`src/modules/anatomy/pdf-reader.ts`, já na identidade do motor).
  - Oferece camada de texto, linhas na ordem de leitura e ponteiro `pdf:sha256=…;page=;line=`.
  - Tem cobertura por página: `text`, `text_with_visual`, `no_text_layer` e `empty`. Não faz OCR.
  - Aceita `source: 'RFB'`.
- **Teste com PDF sintético** no formato de uma SC, com fonte RFB: extração e ponteiros ok, mas a gramática estrutural não conhece o layout da SC. Saíram 11 trechos `unidentified` (cabeçalho, Assunto, Relatório, Fundamentos, Conclusão, assinatura) e 5 parágrafos numerados como `item`.
- **Desenho mínimo:**
  1. **Recurso separado** `rfb:148681:anexo:83325`, representação `attachment`, lido por `readPdfInput`.
  2. **Perfil SC (camada fina sobre a gramática):**
     - cabeçalho e Assunto como `summary`/`prohibited`;
     - "Relatório", "Fundamentos" e "Conclusão" como `group`;
     - parágrafos numerados como unidades;
     - "Dispositivos Legais" como referência;
     - assinatura como `signature`.
     - O contexto da Conclusão é decisão do COORD.
  3. **Identidade do PDF:** o texto precisa conter "SOLUÇÃO DE CONSULTA", "COSIT", o nº 258 e a data de 26/12/2025, iguais à epígrafe; se divergir, recusa.
  4. **Versões:** a ementa tachada sai `historical` e a vigente `prohibited` (resumo). O PDF 82416 (tachado) nunca é lido como vigente.
  5. **Porte:** medido no texto do PDF, nunca no JSON. Até lá fica **indeterminado**.
- **Testes necessários:**
  - SC sintética completa;
  - identidade divergente;
  - PDF digitalizado (`pdf_without_text_layer`);
  - página com imagem (`pdf_page_visual_not_read`);
  - ementa tachada × vigente;
  - anexo tachado nunca lido como vigente;
  - ponteiros página/linha;
  - porte medido no PDF.
- **Menor evidência adicional:** 1 requisição ao PDF 83325, com rota própria e débito SC (saldo SC 3). **Não autorizada nesta etapa.**

## D. Matriz E9: aceite da Portaria (`proposal-303-rfb-acceptance.patch`)

- **Hoje no #303:** `accepted: false` fixo. O mecanismo de dados (`docs/anatomy/e9-acceptances.json`, digest da entrada + motor) existe só na linhagem #305/#309, e só para NORMAS-LEG.
- **Proposta:**
  - mesmo formato de registro;
  - para amostras RFB, conta só se o registro fixar `sha256(canonJson(entrada do lote))` **e** o motor atual;
  - **e** só para leitura **completa**: status `complete`, 0 caracteres não identificados, 0 anexos sem conteúdo, 0 limitações.
  - Leitura parcial nunca é aceita e ganha nota "partial reading".
- **Registro incluído:** `rfb:148693`, digest `7d894b61a3c20f546455baa3282bb032d853dc953059e93696cc39e9924e01ae`, motor `0e009431…`.
- **Completude dos outros três:**
  - 148629: parcial (415 não identificados, 1 anexo, 2 limitações);
  - 148516: parcial (262, 2 limitações);
  - 148681: 2 anexos sem conteúdo.
- **Resultado local:**
  - `test:anatomy` 341/341 (+1 teste: pins exatos, deriva de digest, outro motor, outra amostra e parciais nunca aceitas); `tsc` limpo;
  - **identidade do motor inalterada** (`0e009431`);
  - matriz: 14 cobertas e **1 célula aceita** (`rfb--portaria--medio`).
- **Composição com o #305/#309:** mesmo caminho de arquivo; a resolução é a união dos registros.
- **Limite da matriz:** `validated` continua significando "no lote reprodutível + invariantes". Três das quatro células novas se apoiam em leituras parciais: ADE pequeno, ADE médio e SC pequeno (esta sem corpo). Essas notas as distinguem, mas a contagem de cobertura não muda sem decisão do COORD.

## E. CI

O #310 (`ef7a0795`, draft) fixa o `postgresql-client-16` no `verify`, só na regressão completa. Isso cobre a causa da falha do #303 (`pg_dump` PG 17+ na imagem `ubuntu-26.04`). Nada foi duplicado aqui.

## Correção final antes da revisão (COORD, 2026-11-11)

### Roteiro de revisão do patch A (`proposal-300-type5-express-ref.patch`, base #300 @ `22e8cc48`)
1. **Atributos e HTML malformado:** atributos com `<`/`>`, aspas desbalanceadas, `on*=`, `style` com `expression`, entidades
   e tags em caixa mista dentro de `<table>`. O validador só admite as tags de `FRAGMENT_TAGS`. Os atributos não são
   interpretados pelo validador e passam ao leitor como no #300. Conferir que nenhum atributo vira texto do ato.
2. **Referência expressa × proximidade:** a regra exige as duas coisas, a referência que **termina** o segmento anterior
   (`EXPRESS_REF`) e a adjacência de ordem (`order - 1`). Testar proximidade sem referência, referência no meio da frase,
   referência no segmento seguinte (não vale), dois anexos seguidos (só o primeiro é adjacente) e ordem com lacuna.
3. **Citação, tachado e histórico:** a R3 vem antes da regra nova. Citação aberta, vizinho citado, segmento tachado e
   vizinho `historical`/`unknown` nunca dão `operative_candidate` (E9-A4).
4. **Bytes, hashes e ponteiros:** SHA do payload igual ao decodificado; 26/26 ponteiros no ADE Cofis real; os testes R2
   (BOM, fora do BMP, windows-1252) continuam verdes.
5. **Regressão:** anexo da IN 2.121 (id 67992) igual; lote com delta só de `outputHash`; motor `04af1bfd → 8879065a`;
   base-migration 12/12.

### Patch B r3 (`proposal-303-rfb-acceptance-r3.patch`, base #303 @ `b168c994`)
- **Anexo do próprio ato × citação de outra norma:**
  - `annexMentions` classifica cada menção como `own` ("deste/desta/ao presente…", "em anexo"), `other` ("Anexo I da
    Instrução Normativa…", "Anexo XV, inciso II, do Decreto…") ou `ambiguous`;
  - só `own` + `ambiguous` geram lacuna (conservador);
  - ADE Corat: 2 menções próprias, continua bloqueado.
- **Testes:** B5 cobre 9 casos adversariais; `test:anatomy` 357/357; motor `0e009431` inalterado.
- **Mantido:** a união append-only com os 12 registros do #309; a SC Cosit com porte indeterminado (13/61 cobertas, 1 aceita, só no patch). Nada incorporado.
- **Para a revisão adversarial:**
  - menções no plural ("Anexos I e II desta Portaria" → `ambiguous`);
  - normas citadas por sigla ("Anexo da IN 2.121");
  - "Anexo" como verbo ou substantivo comum ("anexo ao processo").

## R3 (2026-11-11): B2-2, origem da evidência de leitura (composição descartável, nada integrado)

- **Contrato:**
  - **Produtor:** #300, `ops/anatomy/official-lot-rfb.ts` → `inline()` → `readRfbInlineAttachments` grava no lote `inlineAttachments.read[] = { id, sha256, charset, bytes, chars, unidentifiedChars, referenceContext }`. O `sha256` é o SHA dos bytes decodificados do base64 oficial, e só os anexos com estado `read` entram.
  - **Consumidor:** patch B, `collectSamples` → `AnnexReadEvidence` (`id` → `sha256`) → `annexAudit`. Um segmento só fica `read` se o SHA dos seus próprios bytes decodificados for igual ao da evidência daquele `id`.
- **Composição descartável:** #303 @ `6b12ac64` + merge do #300 @ `22e8cc48` (6 conflitos: 4 gerados ou de identidade, 2 de código resolvidos por união) + A r3 + B r5.
  - Motor composto: `37ee5a6b…`.
  - **Evidência real, produtor → consumidor: PROVEN.**
    - ADE Cofis 148629: `read[]` = [82381, `f857a997…`], e o consumidor marca 82381 como `read`.
    - IN 2.121 127905: [67992, `e07a161b…`], e 67992 fica `read`.
  - Portaria 635: sem anexos, `readingComplete` true. **O aceite derivado cai** no motor composto (o registro fixa `0e009431`): é o comportamento correto até a revalidação append-only depois da equivalência.
- **NOT_PROVEN, para a etapa de composição:**
  1. **Caminho positivo de aceite** de uma norma com anexo próprio rotulado e lido: não há amostra real no lote. Precisa de um teste de composição com uma amostra real assim, ou de decisão do COORD.
  2. **`attachmentsWithoutContent`** da preparação principal conta o anexo embutido mesmo depois de lido (ADE Cofis: 1). Na composição, `incompleteness()` precisa descontar os anexos com evidência `read` do mesmo `id` e SHA; sem isso, o ADE Cofis nunca fica completo.
  3. **Contexto de referência:** a evidência traz `referenceContext`. O aceite de completude não deveria exigir `operative_candidate`, mas a decisão é do COORD.
  4. **Ponteiros:** o lote não grava os ponteiros, que são recalculáveis de forma determinística a partir dos bytes (26/26 conferidos no ADE Cofis). Se o COORD quiser no lote, é campo novo.

## R3: patch A r3 (`proposal-300-type5-express-ref-r3.patch`, base #300 @ `22e8cc48`)
- **A2-1:**
  - varredura de tags com profundidade de tachado: tachado aninhado, sem fechamento, fechamento solto ou autofechado → indeterminado → não promove;
  - qualquer `line-through` → não promove;
  - qualquer conteúdo tachado no dispositivo → não promove.
- **A2-2:**
  - entidades decodificadas (nomeadas e numéricas); entidade desconhecida → não promove;
  - negação ou exclusão em **qualquer** ponto do dispositivo;
  - citação de **qualquer** norma identificada (tipo + nº, número com milhar, `n/aaaa` ou ", de aaaa"), sem janela de caracteres.
- **Consequência registrada:** o Art. 1º real do ADE Cofis cita a IN RFB nº 1.155 ("texto misto"). Pelo critério "na dúvida, não promover", a tabela passa a `prohibited`. A leitura continua íntegra: `read`, 9 linhas, 16 células, 26/26 ponteiros, SHA `f857a997…`.
- **IN 2.121:** sem regressão (o anexo 67992 continua `read` e `operative_candidate`).
- **Testes:** suíte do #300 278/278; `tsc` limpo; base-migration PG16 12/12; motor `30482bfd → 62a81cc9`.

## R4 (2026-11-11): A r4, B r6 e provas de composição (nada integrado)

- **B r6** (`proposal-303-rfb-acceptance-r6.patch`, base #303 @ `6b12ac64`):
  - **B3-1:** uma normalização única para menção e cabeçalho: `–`, `—`, hífen com espaços e sufixo minúsculo viram `X-A`. "Rótulo + separador + letras" não modelado → lacuna.
  - **B3-2:** letra isolada ("Anexo I, A e B", "Anexo C", "Anexo L") → rótulo não suportado → lacuna. "V" e "X" continuam romanos.
  - **B2-2:** `rfbReadingAssessment` é a avaliação única por amostra.
    1. caminho positivo de ponta a ponta numa fixture **sintética**; com amostra real, NOT_PROVEN, por falta de fonte;
    2. `attachmentsWithoutContent` é descontado só pelos anexos **comprovadamente lidos** (mesmo id + SHA);
    3. a completude é **independente** do `referenceContext`;
    4. os ponteiros são recalculados dos bytes.
  - `test:anatomy` 374/374; motor `0e009431`.
- **A r4** (`proposal-300-type5-express-ref-r4.patch`, base #300 @ `22e8cc48`):
  - **A3-1:** classe CSS explícita de tachado (`tachado`, `riscado`, `strike…`, `line-through`) → não promove.
  - **A3-2 (decisão do COORD):** a citação **acessória** (fundamento, dispensa) não bloqueia. Bloqueia a norma no **objeto** da referência: a oração que contém a referência ou, se a referência for elíptica (", descritas abaixo."), a oração a que ela se liga. Caudas de citação (", de 2011") não fecham oração. Referência elíptica apoiada numa citação = ambígua → não promove.
  - **ADE Cofis real:** volta a `operative_candidate` **pela regra**. A IN 1.155 está em oração acessória ("dispensadas as exigências…"), e o objeto ("as especificações descritas abaixo") é do próprio ato. Leitura íntegra, 26/26 ponteiros.
  - **Limite mantido:** "É vedada a aplicação das condições descritas abaixo." continua sem promover, porque a negação ou vedação é avaliada na frase inteira. Reclassificar a vedação como operativa depende de decisão do COORD.
  - Testes: 280/280; PG16 12/12; motor `62a81cc9 → 01fd87e5`.
- **Composição descartável** #303 `46afdaf1` + #300 + A r4 + B r6 (motor `61d506cd`):
  - produtor → consumidor: PROVEN (82381, 67992);
  - **desconto real:** no ADE Cofis, o anexo lido zera o "attachment without content"; continua incompleto só pelo preâmbulo `Não Identificado` da fonte;
  - `test:anatomy` 392/396. As 4 falhas são **exatamente** as asserções "só a Portaria aceita": no motor composto, o registro fixado em `0e009431` deixa de valer. A integração precisa de um novo registro append-only depois da equivalência; **não feito, nenhum aceite novo**.

## R5 (2026-11-11): A r5, B r7 e prova formal de equivalência da Portaria 635 (nada integrado, nada registrado)

- **B r7** (`proposal-303-rfb-acceptance-r7.patch`, base #303 @ `6b12ac64`):
  - **B4-1:** `\p{Cf}` removido antes da leitura; separadores = `\p{Pd}`, U+2212, U+FE63, U+FF0D, `/` e `(A)`. `I−A`, `I﹣A`, `I－A`, `I/A`, `I(A)` e `I​-A` exigem I-A, com simetria entre menção e cabeçalho.
  - **B4-2:** `I-`, `I –` e `I/` → não suportado → lacuna.
  - `test:anatomy` 375/375; motor `0e009431`.
- **A r5** (`proposal-300-type5-express-ref-r5.patch`, base #300 @ `22e8cc48`):
  - **A4-1:** uma oração aberta por conector de remissão (`conforme`, `nos termos`, `na forma`, `segundo`, `de acordo com`, `cujo/a/s`) herda a oração antecedente. Uma norma nela bloqueia, inclusive o tipo sem número ("as regras da IN"), **salvo** quando o antecedente é acessório (`dispensad…`, `com fundamento em`, `observad…`). O caso ADE Cofis é preservado.
  - **A4-2:** classe sem aspas e camelCase (`textoTachado`, `TextoRiscado`, `itemTachadoAntigo`) → tachado.
  - **Proibição (decisão do COORD):**
    - `vedad*`, `proibid*` e `impedid*` não bloqueiam quando governam a referência na **mesma oração**, sem elipse, sem conector e sem norma no objeto ("Fica vedada a exportação das mercadorias relacionadas abaixo." → promove);
    - a negação de aplicabilidade, a exclusão, a proibição elíptica, a proibição com norma no objeto, a proibição em outra oração e a proibição tachada continuam sem promover.
  - **Polaridade:** `referencePolarity` (prohibition / permission / obligation) é **só interna**, exportada para testes. Não existe campo persistente nem mudança de contrato, e `legalStatus` continua `unknown`.
  - Testes: 283/283; PG16 12/12; motor `01fd87e5 → 637872fb`.
- **Prova de equivalência** (`portaria635-equivalence.mts` → `portaria635-equivalence-r5.json`):
  - **Base:** #303 + B r7 (motor `0e009431`). **Candidata:** composição descartável #303 `46afdaf1` + #300 + A r5 + B r7 (motor `c9edb4fe`).
  - **Iguais nos dois motores:**
    - bytes (`a98ade77…`) e HTML preparado (`196830e1…`);
    - 136 partes com hash canônico (com `context`, `legalStatus`, `span`, `sourcePointers`, `contextReasons` e `parentId`) `6193225c…`;
    - `canonicalText`, `sourceMap`, `limitations`, `status`, `entities`, `evidence` e `eligibility`.
  - **Identidade:** só `engineHash` difere.
  - **`outputHash`:** `450b2d12…` (base) e `6a318b26…` (candidata); com a identidade do motor neutralizada (`identity.engineHash` constante e `analysisId` recalculado pelo próprio contrato), os dois dão **`60285e2c…`**. A diferença vem **só** da identidade do motor.
  - **Entrada do lote:** diferem `outputHash` e `inlineAttachments` (campo novo do #300). `entrySha256` candidato: `97fab32e…`.
  - **Veredito: EQUIVALENT.**
  - **Registro proposto, NÃO registrado:** `rfb:148693`, `rfb--portaria--medio`, `entrySha256` `97fab32e…`, motor `c9edb4fe…`, `revalidates: rfb:148693 @ 0e009431`.
  - O motor final da integração pode diferir do `c9edb4fe`. Qualquer delta repete a prova. Os 4 testes continuam falhando na composição, como devem, até o registro autorizado.

## R6 (2026-11-11): A r6 — A5-1 e A5-2 (nada integrado, nada registrado)

### Patch

- **Arquivo:** `proposal-300-type5-express-ref-r6.patch`
- **Base:** #300 @ `22e8cc48`
- **SHA-256:** `ec19e5c6d257335e39553cc17684678f3a12c6ef010ab207ec006c012754e1b5`
- **O que muda:** só `referenceObject`/`expressReference`; o restante é o mesmo A r5.
- **Sem novidades de saída:** nenhum campo novo, nenhuma mudança de contrato; `legalStatus` continua `unknown`.

### Regra

1. **Escopo:** somente a sentença da referência.
   - Fim de sentença: `.` seguido de maiúscula, `;` ou `:`. As abreviações `Art.`, `arts.`, `nº.` e `inc.` não encerram sentença.
   - O rótulo de dispositivo é removido antes da análise.
   - Nada é herdado de sentença anterior nem de outro dispositivo.
2. **Remissão** (conector ou elíptica): percorre a cadeia de orações para trás até a oração **governante**, que é a primeira com núcleo nominal e que não começa por modificador nem por conector.
   - **Atravessadas e mantidas na cadeia:** modificadoras (particípio, gerúndio ou advérbio no início) e conectores intermediários.
   - **Puladas:** orações acessórias.
   - **Bloqueio:** uma norma em qualquer ponto da cadeia bloqueia (**A5-1**).
3. **Sem oração governante na sentença:** não promove (**A5-2**).
4. **Elíptica com oração acessória vizinha:** não promove, por ambiguidade.

### Contraprova

`r6-evidence/r6-cases.mts` roda 31 casos dirigidos:

| Motor | Resultado |
|---|---|
| A r5 | 21 FAIL (todos negativos promovidos indevidamente), 10 OK |
| A r6 | 31 OK |

Os testes `R6 A5-1` e `R6 A5-2` falham antes da correção e passam depois.

### A r6 isolado

- `tsc` limpo; `test:anatomy` 286/286; PG16 base-migration 12/12.
- Motor: `637872fb → fff69e074f6ea53c4187ea286cbf2f7f9379e678f8642e3f26a73c80c8592a16`.
- Lote oficial (7 atos, com a IN 2.121): `outputHash` neutralizado idêntico ao do r5 em 7/7, e `inlineAttachments` idêntico (`r6-evidence/lot-neutral-r5-vs-r6.txt`).

### Composição descartável

- **Montagem:** #303 `46afdaf1` + merge do #300 `22e8cc48`.
- **Conflitos:**
  - `build-identity.mjs` por união (`rfb-quote-resume.ts` e `rfb-inline-attachments.ts`);
  - `official-lot-rfb.ts` por união dos dois imports;
  - os 4 arquivos gerados ou de pin vêm de `--ours`.
- **Patches:**
  - A r6 só `src` e `test`, com `test:anatomy` acrescido do teste de anexos;
  - B r7 com `--3way`.
- **Regeneração, nesta ordem e antes dos testes:** `build-identity.mjs --write` → `official-lot-rfb.ts --write` → `official-coverage-matrix.ts --write`.
- **Motor:** `85a1406cff8c3578c0a9e429b31965b2fd38b4e2a67e6803e79f1a05b2d120a7`.
- **`tsc`:** limpo.
- **`test:anatomy`:** 403, sendo 399 pass e 4 fail. As 4 falhas são de identidade (#153, #167, #170, #174): esperam `rfb:148693` aceito em `0e009431`.
- **PG16:** 7/12.
  - O teste 5 falha no pin `0e009431`, e os testes 6–8 caem em cascata.
  - **Cascata provada:** uma cópia descartável do teste com o pin `85a1406c` dá 12/12. A cópia foi apagada e o pin real não foi alterado.
- **ADE Cofis real** (`r6-evidence/ade-cofis-composition-r6.json`): `read`, 9 linhas, 16 células, 26/26 ponteiros, SHA `f857a997…`, `operative_candidate`, `legalStatus` `unknown`.
- **`e9-acceptances.json`:** 13 registros, byte-idêntico à base B r7.

### Portaria 635

Arquivo: `portaria635-equivalence-r6.json`, SHA-256 `8b66384997f09cc02aab71d00e3308acc8eff585eb8998cff4d6c9a27ec30341`. Script inalterado, `c179c65b…`.

**Comparação:** base `0e009431` × candidata `85a1406c`.

**Iguais:**
- bytes `a98ade77…` e HTML `196830e1…`;
- 136 partes, com hash canônico `6193225c…`;
- `differingFields` vazio.

**Diferenças:**
- identidade: só `engineHash`;
- `outputHash` `450b2d12…` × `0f0ab6ad…`; neutralizado, `60285e2c…` nos dois;
- lote: `outputHash` e `inlineAttachments`.

**`entrySha256` candidato:** `5c5ee765347d8d36ef6ebd1d14db095878ec6dc01665d8a0fa35fe05115a1980`.

**Veredito:** **EQUIVALENT** para `85a1406c`.

A prova da R5 (`c9edb4fe`) está **superada** para a identidade candidata. **Nada foi registrado.**

## A r7 (2026-11-14): A6-1 e abreviações normativas (nada integrado, nada registrado)

### Patch

- **Arquivo:** `proposal-300-type5-express-ref-r7.patch`
- **Base:** #300 @ `22e8cc48`
- **SHA-256:** `870521a2105385ae625b5b791addea58d5236954581e51545f18ee9704bf855d`
- **Alcance:** só `rfb-inline-attachments.ts`, o teste correspondente e os arquivos gerados.
- **Pin versionado do #300:** **não alterado**, conforme o mandato; continua `fff69e07`.

### Regra

- **A6-1.** Numa remissão (conector ou elíptica), todas as orações anteriores da mesma sentença entram na verificação, com as caudas de citação unidas.
  - Bloqueiam a promoção: citação de norma, anexo de outra norma e tipo de norma sem número.
  - São excluídos da verificação:
    - orações acessórias;
    - um fundamento anteposto que abre a sentença ("Nos termos da Lei nº …, ficam …", "Com base em …").
  - A mesma expressão inserida depois do verbo continua bloqueando.
  - Os limites de sentença, dispositivo, `;` e `:` não mudaram.
- **Abreviações.**
  - Um ponto só encerra sentença quando o token anterior não é uma abreviação conhecida. Entram na lista `Dec.`, `Decr.`, `Instr.`, `Inst.`, `Port.`, `Res.`, `Resol.`, `Conv.`, `Prot.`, `Compl.`, `Normat.` e `Fed.`, além das anteriores.
  - As formas abreviadas valem como as formas por extenso em `NORM_CITATION`, `NORM_KIND_BARE` e `OTHER_NORM_ANNEX`.

### Contraprova

`r7-evidence/r7-cases.mts` roda 53 casos:
- os 31 da R6;
- 11 de A6-1 (os 5 do revisor, 1 de anexo e 5 positivos);
- 4 pares de abreviação (8 entradas);
- 3 controles de fim real de sentença.

| Motor | Resultado |
|---|---|
| A r6 | 43 OK / 10 FAIL (6 de A6-1 e 4 formas abreviadas) |
| A r7 | 53/53 |

Os testes `R7 A6-1` e `R7 abbreviations` passam de 0/2 para 2/2.

### A r7 isolado

- **Motor:** `1988ba1f0e5a8915d272d29628f1573680f19fa62f9c3b082a352af3f07760d6`.
- **`tsc`:** limpo. **`test:anatomy`:** 288/288.
- **Lote oficial:** 7/7 atos com `outputHash` neutralizado e `inlineAttachments` idênticos ao r6.
- **PG16 com o pin versionado:** 7/12. O teste 5 falha no pin `fff69e07`, e os testes 6–8 caem em cascata.
- **PG16 diagnóstico** (cópia descartável com pin `1988ba1f`): 12/12.

### Composição descartável

- **Montagem:** #303 `46afdaf1` + #300 + A r7 + B r7, com a mesma receita da R6.
- **Motor:** `40f13f413d768ec965225f3540785283a0dd3aefc7a346ac17ca3206206f7675`.
- **`tsc`:** limpo.
- **`test:anatomy`:** 405 testes, 401 pass e 4 fail. As 4 falhas são de identidade:
  - #153, #170 e #174 esperam `['rfb:148693']` aceito;
  - #167 espera o registro com `engineBuildHash` `0e009431`.
- **PG16 com o pin versionado:** 7/12, pelo pin `0e009431` (teste 5) e em cascata (testes 6–8).
- **PG16 diagnóstico:** 12/12.
- **ADE Cofis real:** `read`, 9 linhas, 16 células, 26/26 ponteiros, SHA `f857a997…`, `operative_candidate`, `legalStatus` `unknown`.
- **`e9-acceptances.json`:** 13 registros, byte-idêntico à base B r7.

### Portaria 635

- **Arquivo:** `portaria635-equivalence-r7.json`, SHA-256 `5d58c003637da53e00ae11652bc7a89d925aa9be73abd31a0e0ccc8427dd39e9`.
- **Motores comparados:** base `0e009431` × candidata `40f13f41`.
- **Iguais nos dois motores:**
  - bytes e HTML preparado;
  - 136 partes, com hash canônico `6193225c…`;
  - `differingFields` vazio.
- **O que difere:**
  - identidade: só `engineHash`;
  - `outputHash`: `450b2d12…` × `2a0abf93…`. Com a identidade do motor neutralizada, os dois dão `60285e2c…`.
- **`entrySha256` candidato:** `e835f3ea45177e26e8de1125d3f4418ac26001cb999f7c23c92c4c689e8cbf1b`.
- **Veredito:** **EQUIVALENT**. Substitui as provas da R5 e da R6. **Nada foi registrado.**

## A r8 (2026-11-14): R7-ACC, R7-FRONT, R7-ABBR e R7-PIN (nada integrado, nada registrado)

### Patch

- **Arquivo:** `proposal-300-type5-express-ref-r8.patch`
- **Base:** #300 @ `22e8cc48`
- **SHA-256:** `99d07eee94e626757887afe7b0fefd4469cbdcf6bc2abd712be7de7125b88191`

### Regras

**R7-ACC.** `dispensad…`, `observad…` e `nos termos do art.` contam como acessórios **só quando abrem a oração**.

**R7-FRONT.** Expressões de fundamento que abrem uma oração (`nos termos d…`, `com base em`, `com fundamento em`, `por força d…`) são avaliadas **pela função**, no início ou no meio da frase.
- Elas só são acessórias quando a oração principal é **constitutiva**: `fica(m)/é/são/será` + `autorizad`, `aprovad`, `instituíd`, `estabelecid`, `criad`, `habilitad`, `credenciad`, `concedid`, `deferid`, `reconhecid` ou `homologad`.
- A oração principal é a primeira que não é acessória, nem de fundamento, nem remissão.
- Em qualquer outro caso (a oração aplica, mantém, observa, ou não tem verbo constitutivo), a citação **conta**.
- Uma oração de fundamento nunca é tomada como a governante.

**R7-ABBR.**
- O ponto não encerra a frase quando o token anterior é uma abreviação conhecida **ou** um token capitalizado com até 8 letras. É conservador: unir frases só acrescenta citações a verificar.
- Passam a ser reconhecidas como norma:
  - `Ato Decl. (Interpr.|Exec.)`, `Sol. de Consulta`, `Sol. Cons.`, `Sol.` e `Parec.`;
  - compostas com `Conj.`, `Interm.`, `Norm.` e `Leg.`.
- A cauda da citação pode atravessar o ponto de abreviação.

**R7-PIN.** A trava do próprio patch passa para `2246181e`, com PG16 versionado 12/12. Os pins dos PRs #300/#303 e o aceite da Portaria 635 não foram tocados.

### Contraprova

`r7-evidence/r7-cases.mts` roda 93 casos: os 53 anteriores mais 40 novos (ACC 5, FRONT 13, 9 pares de abreviação com 4 fora do parecer, 4 controles de fim real de frase).

| Motor | Resultado |
|---|---|
| A r7 | 74 OK / 19 FAIL |
| A r8 | 93/93 |

Os testes R8 passam de 0/3 para 3/3.

### A r8 isolado

- **Motor:** `2246181e0c8272dfc9436c03f489084f994d0779311aaa4583058a1dcc23ca09`
- **`tsc`:** limpo
- **`test:anatomy`:** 291/291
- **PG16 com o pin versionado do próprio patch:** **12/12**
- **Lote oficial:** 7/7 atos idênticos ao r7 (`outputHash` neutralizado e `inlineAttachments`)

### Composição descartável

- **Montagem:** #303 `46afdaf1` + #300 + A r8 + B r7, com a receita da R6.
- **Motor:** `ac868e41468db44f4152d9a6bd07b8550eebc1ef0203e4fb8ccad5de613decb1`
- **`tsc`:** limpo
- **`test:anatomy`:** 408 testes, **404 pass e 4 fail**. As 4 falhas são de identidade:
  - #153, #170 e #174 esperam `rfb:148693` aceito;
  - #167 espera o registro com `engineBuildHash` `0e009431`.
- **PG16 com o pin versionado do #303:** 7/12. Falha o teste 5, pelo pin `0e009431`, e os testes 6–8 em cascata.
- **PG16 diagnóstico (pin trocado temporariamente):** 12/12.
- **ADE Cofis real:** `read`, 9 linhas, 16 células, 26/26 ponteiros, `f857a997…`, `operative_candidate`, `legalStatus` `unknown`.
- **`e9-acceptances.json`:** byte-idêntico à base, com 13 registros.

### Portaria 635

- **Arquivo:** `portaria635-equivalence-r8.json`, SHA-256 `9bb27b9ef34670cd4147b48948b05ed4b6f13b9b720ae4b2004a5ca2114c9934`.
- **Comparação:** `0e009431` × `ac868e41`.
- **Resultado:**
  - 136/136 partes, hash `6193225c…`;
  - `differingFields` vazio;
  - identidade difere só em `engineHash`;
  - `outputHash` neutralizado `60285e2c…` nos dois.
- **`entrySha256` candidato:** `486fb648fa05b6565b4af50fef17ffc15f47a9a702757d8667b72e109ae8396d`.
- **Veredito:** **EQUIVALENT**. Esta prova substitui as das versões R5 a R7. **Nada foi registrado.**

## A r9 (2026-11-14): R8-CST, R8-LOW e R8-MRG (nada integrado, nada registrado)

### Patch

- **Arquivo:** `proposal-300-type5-express-ref-r9.patch`
- **Base:** #300 @ `22e8cc48`
- **SHA-256:** `daa2a47c8cd12aaf80eb0f16baa9ed072d951135e1eb23f789af6a445bfd2efe`

### Regras

**R8-CST.** Se o resto da frase **retoma** uma norma citada numa oração acessória ou de fundamento, essa citação passa a contar, mesmo com verbo constitutivo. Vale com a citação no início ou no meio da frase.
- **Retomada pronominal:** "nela", "nele", "nelas", "neles", "dela", "dele", "delas", "deles", "naquela", "daquela".
- **Retomada explícita:** "na/da/pela referida", "mencionada", "citada", "mesma".
- **Não é retomada:** "deste ato", que designa o próprio ato.

**Tipos de norma no plural.** "Leis", "Decretos", "Portarias", "Instruções Normativas" e "Resoluções" passam a citar como o singular.

**R8-LOW.**
- `conj`, `interm`, `norm`, `leg`, `decl`, `interpr`, `exec`, `cons`, `sol` e `parec` entram na lista de abreviações, comparada sem caixa.
- Os tipos abreviados são reconhecidos em qualquer caixa.

**R8-MRG.** Uma frase que **abre** com conector de remissão nunca é fundida à anterior: fica sem resolução e não promove.

**Agravamento do R8-MRG por R8-LOW.** Uma frase real que termina num dos novos tokens minúsculos, seguida de frase sem remissão no início, passa a ser fundida à seguinte. O efeito é conservador: a fusão só acrescenta citações a verificar.

### Contraprova

`r7-evidence/r7-cases.mts` roda 131 casos: os 93 anteriores mais 38 novos.

| Motor | Resultado |
|---|---|
| A r8 | 114 OK / 17 FAIL |
| A r9 | 131/131 |

Os testes R9 passam de 0/3 para 3/3.

### A r9 isolado

- **Motor:** `c313abf0ced515aa5d73768fc8da6b2f4224ce058d34605d42839ecc5b0c828a`
- **Checagens:** `tsc` limpo; `test:anatomy` 294/294
- **Trava do próprio patch:** `c313abf0`, com **PG16 versionado 12/12**
- **Lote oficial:** os 7 atos idênticos ao r8

### Composição descartável

- **Montagem:** #303 `46afdaf1` + #300 + A r9 + B r7, com a receita da R6.
- **Motor:** `3ea4c774126231347280b8c35e87c931b33a3506c58733c1e5f389188ab76318`
- **`tsc`:** limpo.
- **`test:anatomy`:** 411 testes, **407 pass e 4 fail**. As 4 falhas são de identidade:
  - #153, #170 e #174 esperam `rfb:148693` aceito;
  - #167 espera o registro com `engineBuildHash` `0e009431`.
  - **Nenhuma falha nova.**
- **PG16 com a trava versionada do #303:** 7/12. O teste 5 falha pela trava `0e009431`, e os testes 6–8 falham em cascata.
- **PG16 diagnóstico:** 12/12.
- **ADE Cofis real:** `read`, 9 linhas, 16 células, 26/26 ponteiros, `f857a997…`, `operative_candidate`, `legalStatus` `unknown`.
- **`e9-acceptances.json`:** byte-idêntico à base, com 13 registros.

### Portaria 635

- **Arquivo:** `portaria635-equivalence-r9.json`, SHA-256 `4321639a5d19ecad32a9f00a0dd8384fb0dda33ff0922bdd77e92fb802b28319`
- **Comparação:** `0e009431` × `3ea4c774`
- **Partes:** 136/136, hash `6193225c…`; `differingFields` vazio.
- **Diferenças:**
  - `identity.differingKeys` = `["engineHash"]`;
  - `lotEntry.differingKeys` = `["outputHash","inlineAttachments"]`;
  - `outputHash` neutralizado: `60285e2c…` nos dois.
- **`entrySha256` candidato:** `c844c6cb1044ddfec4023f6998dacc4f50d96ab3450f2b6ef218ba8be37301e0` (0 ocorrências no arquivo de aceites).
- **Veredito:** **EQUIVALENT**. Substitui as provas da R5 à R8. **Nada foi registrado.**

## A r10 (2026-11-14): R9-RES e R9-ANA (nada integrado, nada registrado)

Executado por sessão que foi revisora das rodadas R6–R9; a revisão independente do A r10 deve vir de **outra sessão**.

### Patch

- **Arquivo:** `proposal-300-type5-express-ref-r10.patch`
- **Base:** #300 @ `22e8cc48`
- **SHA-256:** `86e47e749bc05e0f0dc73711687a9f5965cb38c001bd391b2e09e108c0c34137`

### Regras

**R9-RES (origem do objeto aprovado).** A lista fechada de retomadas da R9 deu lugar a uma regra aberta. Sob verbo constitutivo, com o verbo removido, o objeto **retoma a norma citada** quando traz:
- particípio de previsão: `previst-`, `estabelecid-`, `fixad-`, `definid-`, `disciplinad-`, `regulad-`, `contid-`, `relacionad-`, `especificad-`, `enumerad-`, `listad-`, `indicad-`, `determinad-`, `aprovad-`, `institu-`, `constante(s)`;
- ou marcador locativo, anafórico ou possessivo: `seu/sua`, `ali`, `lá`, `acima`, `supra-`, `retro-`, `precitad-`, `aludid-`, `em referência`, `referid-`, `mencionad-`, `citad-`, `mesm-`, `tal/tais`, `nel-/del-/naquel-/daquel-/ness-/dess-`.

Nesse caso a citação acessória ou de fundamento conta, e a tabela não é promovida. Na dúvida, não promove.

**Autorreferência expressa.** `nest-/dest-/n- presente` + tipo de ato, `ato`, `norma` ou `Anexo` identifica o próprio ato. Também vale com o particípio que a antecede ("previstas nesta Portaria", "previstas no Anexo desta Portaria", "fixadas pela presente Portaria"). A autorreferência:
- neutraliza o marcador;
- deixa de contar como tipo de norma "nu" no antecedente e no `prior`;
- não neutraliza outra citação na mesma frase ("nesta e na IN nº 1.155" bloqueia).

**R9-ANA (retomada entre frases).** Uma frase que **abre** com "Os/As mesmos/referidos/mencionados/citados/aludidos…", "Tais", "Tal", "Esses/Essas", "Aqueles/Aquelas" fica sem resolução, salvo autorreferência expressa na própria frase. O limite de frase é preservado e nada é herdado.

**Sigla antes do ponto.** Só um token curto em caixa de título ("Conj.", "Norm.") deixa de encerrar a frase. Uma sigla toda em maiúsculas ("RFB.") encerra a frase. As abreviações da lista continuam comparadas sem caixa.

### Contraprova

**Casos dirigidos.** `r7-evidence/r7-cases.mts` roda 210 casos: os 131 anteriores mais 79 novos da seção R10.

| Motor | Resultado |
|---|---|
| A r9 | 163 OK / 47 FAIL |
| A r10 | 210/210 |

Os 131 anteriores ficam idênticos (131/131). Os testes R10 passam de 0/2 para 2/2.

**Adversarial.** `r10-evidence/r10-adversarial.mts` roda 85 casos:
- 13 retomadas do parecer, cada uma no início e no meio;
- 12 variantes novas;
- 5 controles próprios novos, mais os de autorização e modelos;
- casos entre frases.

| Motor | Divergências |
|---|---|
| A r9 | 45/85 |
| A r10 | 0/85 |

**Fechados:**
- o P3 "nesta Portaria";
- o P3 "…da RFB. Fica…".

### A r10 isolado

- **Motor:** `ff8e444f1c5b74b49c9c4eb8dd84e7f3010518816cf9656e137e085adf131180`
- **Checagens:** `tsc` limpo; `test:anatomy` 296/296
- **Trava do próprio patch:** `ff8e444f`, com **PG16 versionado 12/12**
- **Lote oficial:** r9 × r10, 7 atos, 0 diferenças semânticas

### Composição descartável

- **Montagem:** #303 `46afdaf1` + #300 + A r10 + B r7, com a receita da R6.
- **Motor:** `8061ac8257daa5447f1a615e7a1e2c804cc48cd66f9670b161a5f5f01b7862bc`
- **`tsc`:** limpo.
- **`test:anatomy`:** 413 testes, **409 pass e 4 fail**. As 4 falhas são de identidade, as mesmas da R9: #153, #167, #170 e #174. **Nenhuma regressão nova.**
- **PG16 com a trava versionada do #303:** 7/12. O teste 3 falha pela trava `0e009431`, nos subtestes 5–8.
- **PG16 diagnóstico:** 12/12.
- **ADE Cofis real:** `read`, 9 linhas, 16 células, 26/26 ponteiros, `f857a997…`, `operative_candidate`, `legalStatus` `unknown`.
- **`e9-acceptances.json`:** byte-idêntico à base, com 13 registros.

### Portaria 635

- **Arquivo:** `portaria635-equivalence-r10.json`, SHA-256 `f2131d651162017794f5af1311ec51d7f06af16859aeea630b7d631e54145b03`
- **Comparação:** `0e009431` × `8061ac82`
- **Partes:** 136/136, hash `6193225c…`; `differingFields` vazio.
- **Diferenças:**
  - `identity.differingKeys` = `["engineHash"]`;
  - `lotEntry.differingKeys` = `["outputHash","inlineAttachments"]`;
  - `outputHash` neutralizado: `60285e2c…` nos dois.
- **`entrySha256` candidato:** `6c22d5a1b711f46c900b6010970cfa3c1830c193372ec69fc4c2494893061cde` (0 ocorrências no arquivo de aceites).
- **Veredito:** **EQUIVALENT**. Substitui a prova da R9. **Nada foi registrado.**

## A r11 (2026-11-16): R10-RES — retomada sem antecedente próprio (nada integrado, nada registrado)

**Escrita:** só a sessão EXEC `session_01DdUtZuqDfYz8XXwX5uLtJe`. A autoria do A r10 continua `NOT_PROVEN` (#116 c.6923275288).

### Patch

- **Arquivo:** `proposal-300-type5-express-ref-r11.patch`
- **Base:** #300 @ `22e8cc48`
- **SHA-256:** `30db425b0bd35299c0f3d87b573e8a3902942f474d95f8ea8d6b4e303ce45436`

### Regras

**Retomada sem antecedente próprio.** Quando a frase não cita norma própria e contém uma retomada (anafórica, locativa, possessiva ou explícita), a referência fica **não resolvida**. A regra vale em qualquer posição da frase e também depois de verbo constitutivo, analisada sem esse verbo e sem as autorreferências.
- São retomadas: `ali`, `lá`, `acima`, `supra-`, `retro-`, `precitad-`, `aludid-`, `sobredit-`, `dito/dita` como determinante, `em referência`, `referid-`, `mencionad-`, `citad-`, `nel-/del-`, `naquel-/daquel-`, `ness-/dess-`, `seu/sua`, `tal/tais` e `mesm-`.
- Particípios sozinhos ("previstas", "fixadas") não contam como retomada nesta regra.
- Quando a frase cita uma norma, vale a lógica R9/R10.

**Aberturas de frase.** Passam a contar `Estes`, `Estas`, `Os/As demais`, `Ditos`, `Ditas`, `As ditas` e `Sobredit-`.

**Autorreferência.** `diploma` vira autorreferência: "neste/deste/do presente diploma" designa o próprio ato.

**Fronteiras de frase.** "SRF.", "RFB." e "IN." continuam sendo fronteiras reais. Esses casos são resolvidos pela regra da retomada.

**Exceção mantida.** Uma frase que **abre** com retomada e traz autorreferência expressa ("Os mesmos valores previstos nesta Portaria") mantém o resultado da R10.

### Contraprova

| Conjunto | A r10 | A r11 |
|---|---|---|
| Casos dirigidos | 222/243 (as 21 falhas são todas casos R11) | 243/243 |
| Adversariais do EXEC | 0/85 | 0/85 |
| Reconstrução do revisor | 11/21 divergentes | 0/21 |

Os testes R11 rodados no motor A r10 dão 3 falhas, só nos 3 testes novos.

### A r11 isolado

- **Motor:** `66bf03913894097ba54230578efcc25ad2421edd45220a139a8b3f9e51e79711`
- **Checagens:** `tsc` limpo; `test:anatomy` 299/299.
- **PG16 com a trava versionada do próprio patch** (`66bf0391`): **12/12**.
- **Lote oficial:** 7 atos, 0 diferenças.

### Composição

- **Montagem:** #303 + #300 + A r11 + B r7.
- **Motor:** `2ce68110b0499d8ec2da72e430a60857cf65a27c74cc499f9f0b139af1a68a85`
- **`test:anatomy`:** 416 testes, 412 pass e 4 fail. As 4 falhas (#153, #167, #170, #174) vêm só da identidade.
- **PG16:**
  - com a trava versionada do #303: 7/12;
  - com uma trava diagnóstica descartável `2ce68110`: 12/12.
- **ADE Cofis:** 26/26 ponteiros, `operative_candidate`, `legalStatus` `unknown`.
- **`e9-acceptances.json`:** byte-idêntico à base independente #303 `6b12ac64` + B r7, com 13 registros.

### Portaria 635

- **Arquivo:** `portaria635-equivalence-r11.json`, SHA-256 `7054c32c07bf4e168cbe63fb427f767f43a47158d706b3ccce0ab8944a670843`.
- **Comparação:** `0e009431` × `2ce68110`.
- **Resultado:**
  - 136/136 partes iguais;
  - `differingFields` vazio;
  - `identity.differingKeys` = `["engineHash"]`;
  - `outputHash` neutralizado `60285e2c…` nos dois.
- **Veredito:** EQUIVALENT.
- **`entrySha256` candidato:** `7cbbd94b99c12b25b048a73ed3705c15aee39aad0692a7995493dc1a35d5192c`. Aparece 0 vezes nos aceites; **não registrado**.

### Riscos novos (P3, conservadores)

- **R11-1:** "mencionadas nesta Portaria", depois de outra frase, não promove (falso negativo).
- **R11-2:** um possessivo que remete ao próprio objeto ("seus campos") não promove.

### NOT_PROVEN

- 13 dos 34 casos do revisor: a fixture não foi publicada.
- PG18.
- CI integral.

## A r12 (2026-11-16): vocabulário único de marcas de retomada (nada integrado, nada registrado)

**Escrita:** só a sessão EXEC `session_01DdUtZuqDfYz8XXwX5uLtJe`.

### Patch

- **Arquivo:** `proposal-300-type5-express-ref-r12.patch`
- **Base:** #300 @ `22e8cc48`
- **SHA-256:** `0d40bd06dfc389aeee9dc2f1b2afcd549ad8d6b4cb63a0dc86bfd2c0ae9d7090`

### Regra

As regras `FOREIGN_ORIGIN` (frase cita norma) e `RESUMPTION` (frase sem citação) passam a usar **uma só lista** de marcas (`RESUMPTION_MARKERS`).

Marcas acrescentadas:
- `sobredit-`, que faltava em `FOREIGN_ORIGIN`;
- `susodit-`, também nas aberturas de frase;
- `em tela`;
- `em comento`;
- "anterior(es)" quando qualifica ato, norma ou diploma (ato, norma, diploma, Portaria, IN, Lei, Decreto, Resolução etc.). "Exercício anterior" e "mês anterior" não contam.

### Fixtures

- **Os 34 casos do revisor:** copiados literalmente da c.6930068067.
- **Regra geral:** 160 casos, reconstruídos a partir da descrição publicada. O `g.mts` com os 153 casos originais não foi publicado, então a equivalência com ele é **NOT_PROVEN**.

### Resultados

| Verificação | A r11 | A r12 |
|---|---|---|
| 34 casos do revisor | 1 | **0** |
| 160 casos da regra geral | 45 | **0** |
| Casos dirigidos | 253/285 | **285/285** |
| Adversariais | 0/85 | 0/85 |

**A r12 isolado:**
- motor `4aea8f946772794f05511b0338792b39f1d7a5c8f7bce45110041432d7d5ab3d`;
- `tsc` limpo; `test:anatomy` 302/302;
- PG16 com a trava versionada do próprio patch (`4aea8f94`): **12/12**;
- lote oficial: 7/7 atos idênticos.

**Composição:**
- motor `22c6d1f08024cbe65c0a74613ef0bac97481aa1f55c55503f703d8d146d42c22`;
- testes: 419 rodados, 415 pass e 4 fail (#153, #167, #170, #174), só por identidade;
- PG16: 7/12 com a trava do #303; 12/12 com trava diagnóstica descartável;
- ADE Cofis: 26/26 ponteiros, `legalStatus` `unknown`;
- aceites byte-idênticos à base independente, 13 registros.

### Portaria 635

- **Arquivo:** `portaria635-equivalence-r12.json`, SHA-256 `38f7276af515c21f06fb1d5b5a7bf1312cd1731b455419fb5c23b4bcfa585886`
- **Resultado:** **EQUIVALENT** entre `0e009431` e `22c6d1f0`, 136/136 partes.
- **`entrySha256` candidato:** `1f1e593c0a1cbbdfa92756bdefe68d01ad1ddcc0987a12ce66b45fc42697058e`, só no relatório, **não registrado**.

### Falsos negativos conservadores

Casos que deixam de promover conteúdo próprio, todos P3:
- R11-1 e R11-2, já registrados;
- R12-1, novo: "em tela única".

## A r13 (2026-11-17): fechar a origem externa — multicitado, em epígrafe, em questão, em causa (nada integrado, nada registrado)

### Patch

- **Arquivo:** `proposal-300-type5-express-ref-r13.patch`
- **Base:** #300 @ `22e8cc48`
- **SHA-256:** `31c035044838ac2c8959df9aa9b840bb9087445bea4e445a10339749696dfe5f`

### Mudança

O vocabulário único `RESUMPTION_MARKERS` passa a incluir:

- `multicitad-`
- `em epígrafe`
- `em questão`
- `em causa`

Os acentos `í` e `ã` são opcionais e a comparação ignora maiúsculas e minúsculas. As palavras soltas "epígrafe", "questão" e "causa", sem o "em", continuam fora da lista.

### Resultados

| Verificação | A r12 | A r13 |
|---|---|---|
| Sinônimos (46 casos) | 40 | 0 |
| `g.mts` original | 11 | 11 |
| 34 casos originais | 0 | 0 |
| r12 reconstruído | 6 | 2 |
| Casos dirigidos | 290/306 | 306/306 |
| Adversariais | 0/85 | 0/85 |

- No `g.mts`, as 11 divergências restantes são só falsos negativos (FN) conservadores.
- No r12 reconstruído, as 2 restantes são o R12-1, também FN conservador.

**A r13 isolado**

- **Motor:** `8debb5781156c772f4481e86ed5214283ddf1baa9dda98ed9ff74490e322174f`
- **Checagens:** `tsc` limpo; `test:anatomy` 303/303.
- **PG16 com o pin versionado do próprio patch:** 12/12.
- **Lote oficial:** 7/7 atos idênticos.

**Composição**

- **Motor:** `4b96f97783631b77404493139c2c786554222deda2489e66d3b9c29be981d06a`
- **Testes:** 420 testes, 416 passam e 4 falham. As falhas (#153, #167, #170, #174) são só de identidade.
- **PG16 com a trava do #303:** 7/12. Com uma trava diagnóstica descartável, 12/12.
- **ADE Cofis:** 26/26 ponteiros, `legalStatus` `unknown`.
- **Aceites:** byte-idênticos à base independente, 13 registros.

### Portaria 635

- **Arquivo:** `portaria635-equivalence-r13.json`, SHA-256 `dda4a66ce6529d951f6c7af3c77f23eaf5909d296e4014896458ee62e8cc2658`.
- **Resultado:** EQUIVALENT em 136/136 partes.
- **`entrySha256` candidato:** `2958bdb0c4c1f9c30dfd98bc48263be23828db10063f4cc794f8463d975c1996`. Fica só no relatório; **não foi registrado**.

### Riscos

**FN novo (P3, conservador)**

- **R13-1:** "em questão" e "em causa" usados em sentido próprio ("matéria em questão", "bens em causa") deixam de promover.

**NOT_PROVEN**

- `rev.mts`: byte-identidade do arquivo.
- `r12.mts`: original de 73 casos.
- PG18.
- CI integral.
