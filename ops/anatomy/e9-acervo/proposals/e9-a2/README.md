# E9-A2 — completude das 4 células cobertas com `complete=null` (proposta; nada registrado)

Mandato: COORD → EXEC F1 "E9-A2" (tribusca-control#116). Base: main `d53fb3e2`, motor `4b96f977…`.
Escopo: offline, acervo versionado. Nenhuma alteração em `src/`, na matriz ou em `docs/anatomy/e9-acceptances.json`.

| Arquivo | Conteúdo |
|---|---|
| `e9a2-completeness-proof.mts` | prova reprodutível: mesma requisição do `readWith` da matriz, 10 amostras |
| `e9a2-completeness-proof.json` | evidência por amostra e célula; duas execuções byte-idênticas |
| `e9a2-proposed-acceptances.json` | 0 registros: nenhuma amostra APTA |

## Por que a matriz emite `complete=null`

Não é falta de avaliador no motor (`src/`). É a ferramenta da matriz, `ops/anatomy/official-coverage-matrix.ts`:
- `readingComplete` só é atribuído no ramo RFB de `collectSamples`. CONFAZ e Sefaz-SP nunca recebem o campo, e `buildMatrix` dá `complete=null` quando todas as amostras validadas o têm nulo.
- `stages.accepted` só é derivado de `e9-acceptances.json` no ramo RFB. Fora dele, é literal `false`. Hoje nenhum registro, mesmo correto, tornaria essas células aceitas.
- Não existe `entrySha256` definido fora do lote RFB. A proposta mais próxima é o digest canônico da entrada em `official-samples-baseline.json`, registrado em `provenance.baselineEntrySha256`.

## Classificação (rigor E9-A1: status complete, 0 caracteres não identificados, 0 limitações, anexos materiais lidos)

Para as 10 amostras: bytes = meta = baseline; `outputHash` e chars = baseline; `legalStatus` unknown.

| Célula | Amostra | Classe | Evidência decisiva |
|---|---|---|---|
| CONFAZ Convênio grande | http:M3 (Conv. ICMS 142/18) | **BLOQUEADA** | `html_complexity_limit`: a página de 931.597 bytes excede o limite de profundidade/nós do leitor. Texto inteiro como 1 parte não identificada (922.008 chars = HTML bruto); 0 reconhecidos. O porte "grande" mede HTML, não o ato. |
| CONFAZ Convênio grande | http:M4 | **PARCIAL** | status partial. 1.687 chars não-brancos não reconhecidos dentro do ato: ementa, cabeçalho "C O N V Ê N I O", **ANEXO ÚNICO** (título, relação e 9 orientações de preenchimento). 0 partes `annex`: anexo material não lido. `image_without_ocr`. 5.310 chars de menu Plone fora do ato. |
| CONFAZ Ajuste SINIEF grande | M5 (manual) | **PARCIAL** | status partial. 127 chars dentro do ato: "A J U S T E", "OBRIGATORIEDADE DE REGISTRO DE EVENTOS", "REDAÇÃO ANTERIOR DO AJUSTE SINIEF 07/05", rodapé Plone. Anexos I e II lidos (3 partes `annex`). `image_without_ocr` ×2. |
| CONFAZ Ajuste SINIEF grande | http:M5 | **PARCIAL** | Mesmo quadro do M5 manual (127 chars dentro do ato). |
| Sefaz-SP RICMS pequeno | ricms-art008 | **PARCIAL** | status partial. Único texto não reconhecido: cabeçalho hierárquico "SEÇÃO III - DA ISENÇÃO" (18 chars). Também `sefaz_sp_portal_local_preparation_only`: proveniência por preparação local, coleta oficial dos bytes não verificada. |
| Sefaz-SP RICMS pequeno | ricms-art009 | **PARCIAL** | Idem: "Título II - DA SUJEIÇÃO PASSIVA" (26 chars) + limitação de proveniência. |
| Sefaz-SP RICMS médio | ricms-an1art041 | **PARCIAL** | "Livro VI - Dos Anexos" + subtítulo do anexo "(isenções a que se refere o artigo 8º…)" (67 chars); `sefaz_sp_revogado_unidentified`; limitação de proveniência. |
| Sefaz-SP RICMS médio | ricms-an2art003 | **PARCIAL** | "Anexo II - Reduções de Base de Cálculo" + subtítulo "(Relação a que se refere o artigo 51…)" (77 chars) + proveniência. |
| Sefaz-SP RICMS médio | ricms-an2art039 | **PARCIAL** | Mesmo quadro (77 chars) + `sefaz_sp_revogado_unidentified` + proveniência. |
| Sefaz-SP RICMS médio | ricms-art007 | **PARCIAL** | "SEÇÃO II - DA NÃO-INCIDÊNCIA" (24 chars) + proveniência. |

**Resultado:** 0 APTAS, 9 PARCIAIS, 1 BLOQUEADA. Nenhuma das 4 células tem amostra apta.

## Deltas necessários (propostas separadas; nada aplicado)

1. **Matriz (ops, não muda a identidade do motor).** Avaliador de completude e derivação de aceite para fontes não-RFB, mais definição do `entrySha256` (ex.: digest da entrada do baseline). Sem isso, nenhum aceite CONFAZ/Sefaz-SP é possível.
2. **Motor / leitor CONFAZ (muda a identidade, exige novo ciclo).** Delimitar a região do ato na página Plone; reconhecer ementa, cabeçalhos espaçados ("C O N V Ê N I O", "A J U S T E") e "ANEXO ÚNICO" com tabela e notas; tratar a página do M3 sem cair no `html_complexity_limit`.
3. **Motor / leitor Sefaz-SP (muda a identidade).** Classificar os cabeçalhos hierárquicos de contexto (Livro/Título/Seção) e o subtítulo do anexo; tratar o bloco `revogado` não identificado.
4. **Proveniência Sefaz-SP (coleta, fora do motor).** A limitação `sefaz_sp_portal_local_preparation_only` só sai com prova da coleta oficial dos bytes. Decisão de coleta/COORD.

## Reproduzir

```bash
git worktree add --detach /var/tmp/e9a2 d53fb3e2b8d34b9fbeda4da6c5fbdf25a24c19e9
ln -s "$PWD/node_modules" /var/tmp/e9a2/node_modules
cd /var/tmp/e9a2 && npx tsx <este-dir>/e9a2-completeness-proof.mts . out.json && sha256sum out.json
# esperado 0576043806612f5aa98ce9ef3dd62c7b39ee693be6cfb51e2b59f1032aca6d17 (duas execuções idênticas)
```
