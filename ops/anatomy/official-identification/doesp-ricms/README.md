# Sefaz-SP (legislacao.fazenda.sp.gov.br): RICMS/2000, trechos coletados (não promovidos)

Coletados em 2026-11-05 pelo coletor oficial (`consultOfficial`, gate OFFICIAL-01: host oficial DOE-SP, redirecionamentos validados, representação HTML validada). URL, data, SHA-256 e bytes estão em cada `*.meta.json`. Todos `promoted: false`. O RICMS (Decreto 45.490/2000) não consta das chaves reservadas.

| id | Ato | Bytes | SHA-256 |
|---|---|---|---|
| ricms-art007 | RICMS/2000, art. 7º (não incidência) | 165.355 | `11c270fb…` |
| ricms-an2art039 | RICMS/2000, Anexo II, art. 39 (redução de base, alimentos) | 168.294 | `30175769…` |

**Análise local** (motor do #289 @ `5bf45832`, fonte DOE-SP; métrica de diagnóstico, não baseline):
- art. 7º: 44.359 caracteres; **20.065 não identificados**; 1 artigo, 18 incisos, 6 parágrafos, 25 `quoted_text`, 4 tabelas; 24 `image_without_ocr`; 28 `excluded_executable_content`.
- Anexo II, art. 39: 45.433 caracteres; **18.519 não identificados**; 1 anexo, 1 artigo, 20 incisos, 16 parágrafos, 40 `quoted_text`.

**Lacunas observadas (sem correção, dependem de decisão):**
- **L14:** a página é a aplicação SharePoint do portal. Menus, "Compartilhar", pesquisa de opinião e afins entram no texto e ficam `unidentified`. Seria preciso preparar só a região "Conteúdo da Página" (equivalente ao `dou-preparation` para esta fonte).
- **L15:** as notas remissivas "NOTA - V. …" do RICMS não são classificadas como nota editorial pelo perfil DOE-SP.
- **L16:** o art. 7º não mostra nenhum trecho `historical`. É preciso verificar se a página traz redações anteriores marcadas (nas amostras, "Redação" aparece 3 vezes) e como o portal as distingue.
