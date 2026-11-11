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
