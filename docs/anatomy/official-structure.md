# ANAT-04 — estrutura oficial das representações × leitores

Origem: COORD → EXEC, ANAT-04, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244. Análise feita em 17/10/2026 sobre o SHA `b638a27544af75b5a90c1f6b17f7cb75803ce127`.

## Escopo e limites

- Usei somente representações já congeladas no corpus e código já versionado. Não acessei nenhuma fonte, banco ou Railway.
- Entradas analisadas: as sete de **desenvolvimento** disponíveis — IDs 01, 02, 03, 05, 07, 10 (três XMLs) e 11.
- As reservadas 04, 06, 08, 09 e 12 não foram abertas, lidas nem executadas.
- DOE-SP (13–22) e RFB (23–30) não têm corpo original disponível. Para essas fontes, a análise se limita ao contrato de dados que os conectores existentes já consomem.
- Nenhuma conclusão de vigência ou revogação foi tirada de cor, classe CSS ou texto riscado.

Evidência de execução: apliquei `readAnatomyInput` só às entradas de desenvolvimento, para obter o texto canônico, o status e os códigos de limitação. Os tipos de parte foram contados apenas para diagnóstico. Não salvei árvores, não calculei métricas de precisão/recall e não comparei nada com gold, porque o gold ainda não existe.

| ID | Recurso | Preparação | Tamanho (UTF-16) | Status | Partes por tipo (diagnóstico) |
|---|---|---|---|---|---|
| 01 | CV052_91.sanitized.html | HTML inalterado | 194.470 | partial | 13 cláusulas, 14 incisos, 10 alíneas, 10 parágrafos, 6 anexos, 6 tabelas, 2.088 linhas, 4.682 células, 76 notas, 10 não identificadas |
| 02 | CV100_97.sanitized.html | HTML inalterado | 30.591 | partial | 12 cláusulas, 73 incisos, 12 alíneas, 14 parágrafos, 101 notas, 5 não identificadas |
| 03 | 515_…_24377394.xml | CDATA `<Texto>` (provisória) | 432 | partial | 4 não identificadas |
| 05 | 515_…_24382400.xml | CDATA `<Texto>` (provisória) | 1.098 | partial | 3 artigos, 4 não identificadas |
| 07 | 600_…_24382325.xml | CDATA `<Texto>` (provisória) | 1.221 | partial | 7 não identificadas |
| 10 | 602_…_24378456-1/-2/-3.xml | CDATA `<Texto>` por arquivo (provisória) | 11.628 / 7.247 / 4.368 | partial ×3 | 8 artigos, 4 incisos, 3 anexos, 5 tabelas, 224 linhas, 537 células |
| 11 | 602_…_24380292.xml | CDATA `<Texto>` (provisória) | 17.020 | partial | 4 artigos, 9 incisos, 103 redações citadas, 3 não identificadas |

Em todas as entradas, o único código de limitação foi `unidentified_content`.

## CONFAZ (01–02)

**Marcações oficiais preservadas na sanitização**

- `TituloAcordo`: epígrafe.
- `Ementa`: ementa.
- `AcordoTipo`: tipo do ato.
- `TextoAcordo` / `A5-1TextoAcordo`: texto do ato.
- `RedaoAnt` / `A8-3RedacaoAnt`: redação anterior.
- `Remisso` / `A8-1Remissao`: remissão, isto é, nota de alteração.
- `RemissoAnt` / `A8-2RemissaoAnt`: remissão anterior.
- `DataPublicao` / `A2DataPublicacao`: data de publicação.
- Só no 52/91: `TabelaSubtituloverde` (1.156), `Tabelaesquerdaverde` (748), `Tabelajustificadoverde` (626), `A9-1…` e `A9-2…`. São as células das 6 tabelas de anexos.
- Links `<a>` para atos citados: 87 no 52/91 e 71 no 100/97.

**O que pode ser reaproveitado**
- O leitor já cobre epígrafe, ementa, notas, texto e redações históricas, inclusive a herança do histórico do título do anexo para as tabelas.
- A geometria de tabela e o cabeçalho NCM explícito já são tratados.

**Lacunas**
1. `AcordoTipo` não tem regra, e as classes `Tabela*verde` / `A9-*` também não. Hoje as células são reconhecidas pela estrutura de tabela, não pela classe. O sufixo "verde" é **apresentação**: não pode virar indício de vigência nem de histórico.
2. Ficaram partes não identificadas: 10 no 52/91 e 5 no 100/97. Antes de criar regra, a anotação precisa dizer se são epígrafe secundária, assinaturas ou rodapé editorial.
3. Os links `<a>` citam atos sem resolver identidade. A camada de citações deve continuar usando o texto e tratar o `href` apenas como `sourcePointer`, sem resolver automaticamente.

## DOU (03, 05, 07, 10, 11)

**Estrutura oficial do XML do INLABS**
- O arquivo começa com BOM UTF-8.
- O elemento `<article>` traz atributos de publicação: `idMateria`, `pubName`, `artType`, `artCategory`, `artClass`, `pubDate`, `numberPage`, `pdfPage`, `editionNumber`. Às vezes traz também `artNotes`, com nota interna de diagramação (por exemplo, "NÃO PUBLICAR").
- `<body>` tem `Identifica`, `Data`, `Ementa`, `Titulo`, `SubTitulo` em CDATA, e `<Texto>` com um **fragmento HTML em CDATA**.
- Dentro do HTML aparecem as classes oficiais `identifica`, `ementa`, `assina`, `cargo` e `anexo`, além de `<table>`, `<tr>` e `<td>`.
- Identificação e ementa aparecem **duas vezes**: nos elementos de metadado e repetidas como `<p>` dentro de `<Texto>`.
- Uma mesma matéria pode vir dividida em vários arquivos, com `name` terminando em `_001`, `_002`, `_003` e páginas distintas (ID 10: páginas 8, 10 e 11).

**O que pode ser reaproveitado**
- Redação citada com aspas ASCII e fechamento `" (NR)` já é tratada. No ID 11 o leitor marcou 103 partes `quoted_text` como zona proibida, que é o comportamento conservador correto para uma IN que altera outra.
- Marcadores de artigo, inciso e anexo e as tabelas também já funcionam (IDs 05, 10 e 11).

**Lacunas que exigem tratamento próprio**
1. **Não existe preparação XML → representação.** O documento de leitores já proíbe passar o XML como HTML. A extração do CDATA de `<Texto>` usada nesta análise é **provisória** e precisa virar uma etapa versionada, com:
   - `sourcePointer` para o arquivo XML e para o intervalo do CDATA;
   - exclusão explícita de `artNotes` e dos metadados duplicados;
   - BOM fora do texto.
2. **O perfil DOU ignora as classes oficiais.** `identifica`, `ementa`, `assina` e `cargo` poderiam mapear, respectivamente, para epígrafe, ementa (zona proibida), assinatura e cargo. O ID 03 (retificação) ficou 100% não identificado e o ID 07 (despacho) também.
3. **Retificação "onde se lê / leia-se" não tem modelo.** O ID 03 precisa de partes para o trecho original e o corrigido, ligadas ao ato retificado (Portaria 340/2026). Sem isso, os números do processo correm o risco de ser lidos como NCM; o domínio de processo já é protegido nas entidades.
4. **Continuação em vários arquivos:** hoje cada XML gera um resultado separado. O ID 10 precisa de uma única representação, com os três recursos em ordem (`_001` → `_003`), o mapa de origem por recurso e um manifesto de anexos. A continuação não pode reiniciar o ato.
5. **Pareamento das aspas no ID 11:** há 25 marcas `(NR)`, mas só 24 seguem o padrão `" (NR)`. A anotação precisa conferir, manualmente, onde termina cada redação citada antes de qualquer ajuste de regra.

## DOE-SP (13–22): sem corpo original disponível

Pelo que o conector existente já consome (`src/modules/collection/doe-sp.parser.ts`), o JSON `v2/publications/{id}` traz:
- título, slug, data;
- `hierarchy`, como string separada por `>`;
- corpo HTML;
- `attachments`, com `position`, ordenados por posição e id.

O inventário registra que as variantes de `test/doe-sp.fixtures.ts` são truncadas ou derivadas: elas **não** servem para analisar a marcação oficial. A análise das classes reais do HTML DOE-SP fica pendente até a recuperação ou a recaptura autorizada.

Já se sabe que há:
- resíduos de Word fora do conteúdo jurídico (ID 17);
- referência a anexo PDF sem tabela embutida (ID 21);
- atos de pessoal com dados pessoais (IDs 19 e 22), que precisam de uma representação sanitizada à parte.

## RFB (23–30): sem corpo original disponível

Pelo que `src/modules/collection/rfb-normas.parser.ts` já consome, a API `visao/original` traz:
- segmentos em `ementas`, ordenados por `ordemSegmentoAto`;
- `textoIntegra` em HTML;
- a flag `omitir`;
- `arquivoBinario`, que é anexo servido por `anexoOutros.action`.

Lacunas conhecidas:
- o leitor ANAT não consome segmentos; recebe um único HTML;
- tabelas podem estar somente em `arquivoBinario`;
- as visões vigente e multivigente não são corpo consolidado.

Uma preparação RFB precisa:
- concatenar os segmentos com ponteiro por segmento;
- declarar os segmentos omitidos como ausentes;
- incluir os anexos binários no manifesto, sem inventar conteúdo.

## Resumo

| Item | Reaproveitável agora | Exige tratamento próprio |
|---|---|---|
| CONFAZ classes legais/históricas | Sim | `AcordoTipo`, classes `Tabela*` (sem semântica de vigência) |
| DOU redação citada `" (NR)` | Sim | Conferir o pareamento das aspas |
| DOU XML/CDATA | — | Preparação versionada, exclusão de metadados e de `artNotes` |
| DOU classes `identifica/ementa/assina/cargo` | — | Perfil DOU |
| DOU retificação | — | Modelo "onde se lê / leia-se" |
| DOU vários arquivos | — | Uma representação com vários recursos |
| DOE-SP / RFB | Contrato dos conectores | Corpo original; segmentos RFB; anexos |

Estas lacunas são proposta de trabalho, não alteração. Nenhuma regra, perfil ou leitor foi modificado nesta etapa.
