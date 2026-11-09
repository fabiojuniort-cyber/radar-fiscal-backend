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
- Saída A: contagem por fonte × tipo × porte. Saída B: até 3 candidatos por célula, publicados antes de 2026 (margem dos reservados), com os casos perto de uma fronteira de porte por último.
- Conferido em PostgreSQL 16 descartável local com todas as migrations da `main` e linhas sintéticas: porte, corte de 2026 e ordem conferem.

**Antes de qualquer captura**, cada candidato precisa passar pela lista de reservados (`RESERVED_ACT_KEYS` e `RESERVED_SOURCE_IDS` da cadeia #303). A captura continua sendo da representação oficial (JSON multivigente RFB; JSON v2 DOE-SP), dentro dos tetos já aprovados, com o mesmo ledger e o mesmo dono.

## 5. Reprodução

```bash
npx tsx ops/anatomy/e9-acervo/rfb-acervo-equivalence.mts "$PWD"
```

Rodar numa cópia do #305 @ `d6d991ef` (com `ops/anatomy/official-identification/`). Os insumos são os 10 snapshots RFB versionados; o script recusa bytes com SHA divergente.
