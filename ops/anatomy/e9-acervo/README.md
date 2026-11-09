# E9-ACERVO-01 — o Acervo já coletado cobre as lacunas RFB e DOE-SP da E9?

Pacote COORD → EXEC E9-ACERVO-01, [tribusca-control#116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116). Escopo: leitura autorizada, validação offline e preparação do aceite. Nada aqui consulta fonte externa, escreve em banco, ativa flag ou mexe em corpus, gold ou reserva. P2-c e P2-d continuam pausados.

Estado observado em 09/11/2026 02:20 BRT: matriz E9 **11/61** (#305 @ `d6d991ef`, a célula normas.leg.br × Lei × HTML × grande está `validated`, não `accepted`); Frente 1 = **50,2%**; E9 = 0.

## 1. O que o Acervo guarda (código da `main` @ `bb6c6179`)

| Fonte | O que vai para `publication_versions` | O que não vai |
|---|---|---|
| RFB (`rfb-normas`) | `content_text` = texto da **visão original** (`rfb-normas.connector.ts:485`); `source_metadata.presentation` = HTML da visão original **sanitizado** (`SANITIZED_HTML`, `legal-presentation.ts`) | O JSON da API; a visão **multivigente** (só `normalizedHash` e URL); os atributos `data-rfb-*` que o leitor RFB usa (tipo declarado de segmento, ordem, tachado) |
| DOE-SP (`doe-sp`) | `content_text` = texto do `content`; `presentation` = `content` sanitizado | O JSON da API v2 (`id`, `slug`, `journal`, `content` bruto) que `prepareDoeSpRepresentation` exige |

O sanitizador mantém só um conjunto fixo de tags e as classes CONFAZ; tira `style` e as demais classes. HTML acima de 2 MiB não é guardado.

## 2. Prova: a representação do Acervo não serve para o leitor RFB

`rfb-acervo-equivalence.mts` lê, **offline**, os 10 atos RFB reais já preservados no repositório (bytes conferidos com o SHA-256 de cada `*.meta.json`) de duas formas:
- **A** — caminho validado da matriz: `prepareRfbRepresentation` + perfil `RFB`;
- **B** — equivalente ao Acervo: o mesmo JSON passa pelo caminho do conector (`parseRfbApiRepresentation`) e pelo sanitizador de produção; o HTML resultante é lido como `DOU`, porque o perfil `RFB` não tem como ler HTML sem `data-rfb-*`.

Motor `9235a810` (código do #305 @ `d6d991ef`), Node 22. Resultado completo em `rfb-acervo-equivalence.result.json` (SHA-256 `74cf04c6…`).

| idAto | Ato | Porte | A: tipos declarados / partes `historical` | B: idem | Texto canônico igual? |
|---|---|---|---|---|---|
| 108391 | IN 1932 | pequeno | 2 / 0 | 0 / 0 | sim |
| 133898 | IN 2162 | pequeno | 2 / 4 | 0 / 0 | sim |
| 141910 | IN 2237 | médio | 17 / 12 | 0 / 0 | sim |
| 115131 | IN 2005 | grande | 24 / 365 | 0 / 0 | sim |
| 116968 | IN 2021 | grande | 31 / 76 | 0 / 0 | sim |
| 104314 | IN 1911 | grande | 652 / 4.736 | 0 / 0 | sim |
| 127905 | IN 2121 | grande | 644 / 790 | 0 / 0 | sim |
| 122645 | Resolução CGSN 164 | pequeno | 2 / 2 | 0 / 0 | sim |
| 142967 | Portaria RFB 514 | pequeno | 2 / 0 | 0 / 0 | sim |
| 37103 | ADI | pequeno | 1 / 3 | 0 / 0 | sim |

- O texto canônico é o mesmo, mas **toda** a estrutura declarada pela fonte e **todo** o tachado (redação anterior) se perdem: em B, o texto revogado aparece como texto comum.
- Em A e B, `legalStatus` fica sempre `unknown` e nenhuma citação vira operativa; B termina `partial` nos 10.
- **Conclusão:** a cópia do Acervo é uma representação que perdeu a estrutura necessária. **Não cobre** nenhuma célula RFB (`JSON multivigente`). Também não é a visão multivigente.

**O que o Acervo resolve:** o porte. O comprimento de `content_text` deu o mesmo porte que o motor em 10/10 (diferença máxima 0,31%). Isso elimina a busca, que era o bloqueio do P2-c (as buscas gravadas só traziam ementa, sem tamanho). Como o Acervo guarda a visão original, o porte da multivigente é maior ou igual.

## 3. DOE-SP

- O Acervo tem 5.326 publicações DOE-SP e 982 RFB (`GET /public/v1/sources`, 09/11/2026 02:14 UTC). A API pública não expõe texto nem tamanho.
- A representação guardada é o `content` **sanitizado**, sem o envelope JSON. A preparação DOE-SP (`json-preparation.ts`) ainda é **provisória**, feita só com fixtures sintéticas, e não há perfil DOE-SP validado. Não existe no repositório nenhum JSON DOE-SP real fora do corpus e da reserva para medir a perda, como foi feito no §2.
- **Estado:** acesso e representação **não comprovados**. Não é "não encontrado".
- **Amostra mínima:** a primeira captura P2-d de cada tipo. Ela traz o JSON bruto e permite repetir o §2 (bruto × sanitizado). Se a perda for nula, o Acervo passa a valer como fonte de candidatos e de comparação para as 9 células DOE-SP. Se não for, cada célula precisa da captura bruta.

## 4. Inventário de candidatos (SQL somente leitura)

`01_candidates_readonly.sql` é para o Fábio rodar no Dashboard: esta sessão não tem canal ao banco de produção.
- Transação `READ ONLY` com `statement_timeout` de 15 s, terminando em `ROLLBACK`.
- Lê só metadados globais (tipo, número, órgão, data, URL oficial, `external_id`), comprimento e hash. Não lê texto, tenant, empresa ou usuário.
- Saída A: contagem por fonte × tipo × porte. Saída B: até 5 candidatos por célula, publicados antes de 2026 (margem dos reservados). Ficam por último os casos perto de uma fronteira de porte e os publicados de 01 a 15/01: nesses, o ato pode ser do ano anterior, e a captura direta exige o ano do ato igual ao do alvo.
- **Revisão final (R3):**
  - `external_id` do RFB é o `idAto` (`rfb-normas.connector.ts`);
  - `act_number` fora de dígitos é recusado pelo seletor (falha fechada);
  - linhas de status do `psql`, como `ROLLBACK`, são ignoradas;
  - conferido de novo em PG16 descartável: o ato de 2026 fica fora e o de 05/01 cai para o fim.
- Conferido em PostgreSQL 16 descartável local com todas as migrations da `main` e linhas sintéticas: porte, corte de 2026 e ordem conferem.

**Antes de qualquer captura**, cada candidato precisa passar pela lista de reservados (`RESERVED_ACT_KEYS` e `RESERVED_SOURCE_IDS` da cadeia #303). A captura continua sendo da representação oficial (JSON multivigente RFB; JSON v2 DOE-SP), dentro dos tetos já aprovados, com o mesmo ledger e o mesmo dono.

## 5. RFB — plano mínimo de captura direta da multivigente (preparado; nada executado)

`plan-rfb-captures.mts` lê o CSV da consulta B do SQL e um checkout do #303. Ele aplica os filtros abaixo e devolve **um candidato por célula pendente**, as alternativas e o saldo previsto. Não envia requisição, não altera o grant e não grava ledger. Para cada candidato, recusa:
- o que não é `rfb-normas` ou não tem `idAto` numérico (no Acervo, `external_id` é o `idAto`);
- o `idAto` já capturado (os 10 snapshots do repositório);
- os `RESERVED_SOURCE_IDS`;
- o que foi publicado em 2026 ou não tem data;
- o que não tem chave de ato legível (falha fechada, como a guarda do #303), ou cuja chave está em `RESERVED_ACT_KEYS`;
- um "pequeno" perto de 10.000 caracteres: o Acervo guarda a visão original, e a multivigente é maior ou igual.

Conferido com `fixtures/synthetic-candidates.csv` (dados sintéticos) contra o #303 @ `5a8337bc`: recusou o já capturado (142967), o id reservado (153743), 2026 e o pequeno perto da fronteira. "Não encontrado no Acervo" é diferente de "inexistente".

**Saldo previsto** (grant `E9-P2c-G1`: 16, tetos por tipo, `used` 0, suspenso):

| Tipo | Células pendentes | Capturas planejadas (sem busca) | Teto | Folga para alternativa |
|---|---|---|---|---|
| Portaria | médio, grande | 2 | 3 | 1 |
| ADI | médio, grande | 2 | 2 | 0 |
| Resolução | médio, grande | 2 | 3 | 1 |
| ADE | pequeno, médio, grande | 3 | 4 | 1 |
| Solução de Consulta | pequeno, médio, grande | 3 | 4 | 1 |
| **Total** | **12** | **no máximo 12, 0 buscas** | **16** | **4** |

**Decisão pronta para o COORD:**
- **D1 (método):** trocar a busca (opção b) pela seleção no Acervo. A captura passa a ser só da visão multivigente, por `idAto`, uma por célula. Os débitos (captura, redirect, retry, falha) continuam no mesmo ledger, com dono único.
- **D2 (limites):** **não é preciso redistribuir.** O plano cabe nos tetos de cada tipo. Única alternativa: mover 1 de ADE ou SC para ADI, dando a ADI uma alternativa; recomendo manter os tetos.
- **D3 (porte):** se a multivigente cair noutro porte, a captura conta para a célula onde cair, nunca para a planejada. A célula planejada só usa a alternativa dentro da folga do tipo.
- **D1–D3 decididos pelo COORD (R3):** o Acervo substitui a busca, sem redistribuição; a célula só é coberta pelo porte medido na multivigente.
- **Captura direta (R3, #303):** `runDirect` em `collect-p2c.ts` consome a lista `targets` deste seletor (`--targets`):
  - a URL é gerada a partir do `idAto` validado;
  - antes de qualquer requisição, saem o já armazenado, o reservado, o duplicado e o que passa do teto;
  - depois da captura (debitada), saem identidade divergente (tipo, número ou data do ato) e ato de 2026.
- **Execução** (fora desta rodada): depois do recheck do delta do #303, o Fábio roda o SQL, o EXEC gera `targets`, e então vem a ativação do G1.

## 6. DOE-SP — teste mínimo com uma amostra real (preparado)

`doesp-acervo-equivalence.mts` recebe **um** JSON de detalhe da API v2 (bytes como recebidos) e compara a leitura `DOE-SP` de (A) `prepareDoeSpRepresentation` (o `content` sem alteração) com a de (B) `parseDoeSpDetail` + sanitizador de produção (o que o Acervo guarda). Ele conta, no `content` bruto, a marcação que o sanitizador descarta e lista as diferenças de status, texto, tipos, contextos, limitações e não identificados.

**Comprovado pelo código (sem amostra):**
- O sanitizador descarta `class` e `style` (exceto as classes CONFAZ), `img`, `s`/`strike`/`del`, `svg`, `script` e `style`. Mantém tabelas com `colspan`/`rowspan`, links seguros e o texto. HTML acima de 2 MiB não é guardado.
- O perfil DOE-SP não usa classes (as listas estão vazias); a perda de `class` não muda a leitura atual.
- O Acervo perde os sinais `image_without_ocr` e `excluded_executable_content`, que o leitor emite a partir de `img` e `script`.
- A preparação DOE-SP é provisória; não existe perfil DOE-SP validado.

**Conferido só com fixture sintética** (`fixtures/synthetic-doesp-detail.json`, texto escrito para o teste) nos motores `9235a810` (#305) e `b6ccf583` (main):
- texto e partes iguais;
- diferença só nas limitações (a imagem e o script somem em B).
- Achado do próprio leitor, independente do Acervo: texto com `line-through` ou `<s>` é lido como `operative_candidate` **mesmo no JSON oficial**.

**Depende da amostra real:**
1. Se o DOE-SP real usa tachado ou `style` para a redação anterior. Se usar, é lacuna do leitor DOE-SP, não só do Acervo.
2. Se há imagem ou anexo no corpo.
3. Se o `content` passa de 2 MiB.
4. Se o texto canônico de A e B é idêntico.

**Amostra mínima:** 1 detalhe DOE-SP da API v2, anterior a 2026 e fora dos reservados. O ideal é um Decreto médio com tabela ou redação alterada. Pode ser a 1ª captura do P2-d (#304), já dentro do teto; não pede requisição a mais.

## 7. Reprodução

```bash
npx tsx ops/anatomy/e9-acervo/rfb-acervo-equivalence.mts "$PWD"
```

Rodar numa cópia do #305 @ `d6d991ef` (com `ops/anatomy/official-identification/`). Os insumos são os 10 snapshots RFB versionados; o script recusa bytes com SHA divergente.

```bash
# Plano RFB (CSV exportado da consulta B; checkout do #303)
npx tsx ops/anatomy/e9-acervo/plan-rfb-captures.mts <candidates.csv> <checkout-303>
# Teste DOE-SP (1 detalhe da API v2; GUID esperado; SHA-256 opcional)
npx tsx ops/anatomy/e9-acervo/doesp-acervo-equivalence.mts "$PWD" <detail.json> <guid> [sha256]
```
