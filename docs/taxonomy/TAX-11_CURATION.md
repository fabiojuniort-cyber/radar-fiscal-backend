# TAX-11 — Curadoria configurável da Taxonomia TriBusca

A partir da TAX-11 a taxonomia é mantida em **tabelas configuráveis** pela
curadoria (fonte oficial a partir da v1.2). O dicionário R6 em Markdown fica
como histórico das releases v1.0.0/v1.1.0.

## Modelo

Tudo que o curador edita é **escopo de release**:

1. `POST /api/v1/admin/taxonomy/drafts` copia a última release `PUBLISHED`
   para um `DRAFT` (`manifest.kind = TAX-11_CURATED_RELEASE`). Só existe um
   rascunho de curadoria aberto por vez.
2. O curador edita dimensões, grupos, itens (conceitos), sinônimos e códigos
   oficiais no rascunho. Mudanças semânticas (nome, definição, exemplos,
   status) criam nova revisão append-only; configurações de apresentação
   ficam na linha da release.
3. `GET …/drafts/current/review` mostra diferenças contra a publicada e
   validações (bloqueios e alertas).
4. `POST …/drafts/current/publish` publica a nova versão (`vX.(Y+1).0`).
   O snapshot publicado continua imutável pelos triggers existentes.

Na primeira criação a partir de uma release sem configurações (v1.1.0), o
rascunho recebe uma **proposta inicial** marcada `Sugestão TAX-11 — conferir`
(`curation.seed.ts`): grupos para produto/operação/tema/tratamento/tributo/
regime/documento/obrigação, NCM sugerido por produto, CNAE sugerido por
segmento, rótulos "NF-e; 55" separados em nome + modelo e "classificar pelo
nome" desligado para nomes genéricos (ex.: "Lei", "Venda", "Federal").

### Configurações

| Onde | Campo | Uso |
|---|---|---|
| dimensão | `profile_visible`, `profile_order`, `help_text` | Perfil Tributário |
| dimensão | `detail_section`, `detail_order` | seção na página da legislação |
| dimensão | `uses_groups`, `official_code_type` | grupos e tipo de código (NCM, CNAE, DOCUMENT_MODEL, CCLASSTRIB…) |
| grupo | `label`, `display_order`, `official_codes`, `detail_section` | agrupamento (ex.: Segmento → Grupo → Produto) |
| grupo | `taxonomy_release_group_segments` | segmentos atendidos por um grupo de produtos |
| item | `profile_visible`, `display_order`, `help_text` | Perfil Tributário |
| item | `classify_by_label`, `official_codes`, sinônimos | classificação automática |

Releases anteriores (colunas NULL) usam os padrões legados de
`curation.constants.ts`: as 8 dimensões que o site exibia no Perfil Tributário
antes da TAX-11 (a API antiga também devolvia Tema/Tratamento/Sujeito, mas o
site os filtrava e nunca salvou códigos dessas dimensões).

## Edição em grade e carga massiva (TAX-11b)

- `POST /api/v1/admin/taxonomy/drafts/current/dimensions/:code/rows` salva de uma vez
  as linhas da grade (novas, alteradas) e a lista `retire`. É tudo ou nada: a primeira
  linha inválida aborta a transação e a mensagem cita “Linha N (“nome”)”.
- Linha nova sem código: o código é `dimensão.slug(nome)`; se já existir, recebe sufixo
  `_2`, `_3`… Um conceito histórico da mesma dimensão fora do rascunho é reaproveitado.
- Planilha: exporta “No perfil” e “Classificar pelo nome” com `x`; a importação aceita
  `x`, `✓`, `sim`, `1`. “Código TriBusca” vazio gera o código pelo nome (mesmo nome
  atualiza o item existente). A importação também lê “Classificar pelo nome” e “Definição”.
- O motivo é opcional na interface; sem texto, o site envia “Curadoria da taxonomia”
  (a API continua exigindo um motivo para a auditoria).

## Sinônimos: um tipo só (decisão do PO, 03/10/2026)

- Para o curador existe um único tipo de sinônimo, e **todo sinônimo marca as
  legislações em que aparece**. O classificador curado (`tribusca.taxonomy.curated`
  **2.1.0** em diante) usa todos os sinônimos, qualquer que seja o tipo gravado. A versão nova do
  motor reclassifica pelo selo o que já tiver sido classificado.
- Sinônimos que o dicionário TAX-02 marcou como `AMBIGUOUS` ou `SEARCH_RELATED`
  (ex.: “IE”, “ST”, “Cashback”, “DRC”, “Abatedouro”) aparecem na revisão como aviso
  `SYNONYM_WAS_NOT_AUTOMATIC`, para o PO decidir se ficam antes de publicar.

## Algarismos romanos (motor 2.2.0)

- A comparação ignora maiúsculas, minúsculas e acentos (decisão do PO, 04/10/2026).
- Termo que também é algarismo romano (“II” = Imposto de Importação) não conta quando
  é numeração do ato: começo de parágrafo (“II - às saídas”), seguido de “-”/“)”, em
  listas (“incisos I e II”, “II a IV”, “I, II”) ou depois de inciso/alínea/item/anexo/
  capítulo/título/seção/art./nº. “(II)” e “do II e do IPI” continuam contando.
- No Conv. ICMS 100/97 as 21 ocorrências de “II” são incisos: nenhuma marca mais o tributo.

## Acesso

- Papel de plataforma `TAXONOMY_CURATOR` em `platform_user_roles` (global, não
  de tenant). Concedido só por comando operacional
  (`npm run taxonomy:grant-curator -- --email=<e-mail>`).
- As rotas de curadoria escrevem por um login dedicado
  `radar_taxonomy_curator_runtime` (NOINHERIT, membro só de
  `radar_taxonomy_curator`), provisionado pelo `db:prepare` quando
  `DB_CURATOR_RUNTIME_PASSWORD` existe. API/Worker continuam sem escrita na
  taxonomia canônica (T04-D13).
- Toda escrita exige justificativa e grava `audit_log` (`actor_type = ADMIN`).

## Classificação automática

- Interruptor `taxonomy_runtime_settings.classification_enabled` —
  **nasce desligado**; o curador liga depois de revisar as tabelas.
- `classification_excluded_sources` nasce com `["doe-sp"]`: o guard da
  reconstrução DOE-SP recusa histórico de classificação em publicações do
  escopo. O DOE-SP também é excluído no código (`PROTECTED_EXCLUDED_SOURCES`)
  e a API recusa removê-lo; voltar a classificá-lo exige mudança própria após
  o fechamento formal do DOE-SP.
- O Worker roda `processPublicationTaxonomyBatch` após a detecção de NCM
  (20 por ciclo ocioso, 10 após cada coleta), mais recentes primeiro.
- Selo: `publication_taxonomy_scans` por versão × release × motor. Sem selo
  `SUCCESS` = pendente; publicar nova release ou mudar o motor reenfileira o
  acervo inteiro (legado incluso) sem apagar histórico. Falhas são retentadas
  até 3 vezes (intervalo de 15 min) e, depois, uma vez por dia — uma falha
  sistêmica corrigida por deploy se recupera sozinha.
- Sinais: nome do item (se `classify_by_label`), sinônimos
  `EXACT_LEXICAL`/`ABBREVIATION`, prefixo NCM contra menções NCM detectadas e
  cClassTrib citado no texto. Cada tag guarda o trecho/termo que a gerou.

## Tags na legislação

- `GET /api/v1/publications/:id/taxonomy` — seções configuradas, motivo de cada
  tag, status (`CLASSIFIED`, `PENDING`, `DISABLED`, `EXCLUDED`, `FAILED`).
- `GET /api/v2/archive?tag=<código>` — Acervo filtrado por tag efetiva.
- Curador: `POST /api/v1/admin/taxonomy/publications/:id/tags`
  (`ADD`/`REMOVE`/`RESTORE`). Cada correção grava um evento por conceito em
  `publication_taxonomy_curator_tags` (append-only); a decisão mais recente
  por versão da legislação × conceito vale também nas releases seguintes.
  Remover/restaurar tag automática grava ainda `REJECT`/`CONFIRM` em
  `publication_taxonomy_reviews` (trilha da asserção julgada).
- Planilha: coluna ausente ou célula vazia mantém o valor atual; "—" ou "-"
  limpa o campo.
- Segmento pelos produtos: cada produto marcado leva aos segmentos do seu
  grupo (`taxonomy_release_group_segments`); o segmento entra como tag
  automática com motivo `PRODUCTS` ("Pelos produtos citados: …"), a menos que
  já tenha sido marcado pelo texto. O curador remove/restaura como qualquer tag.

### Afinidade com a empresa

`GET /api/v1/companies/:companyId/publications/:id/affinity` (cabeçalho
`X-Tenant-Id`) cruza as tags da legislação com o Perfil Tributário vigente da
empresa. Pesos por tipo: produto e segmento 3; tributo, regime, operação,
finalidade e tratamento 2; espécie tributária, documento, obrigação e tema 1;
demais (ex.: tipo de ato) 0. Um produto do perfil também casa com a tag de
grupo da lei. Nível: **Alta** com pontuação ≥ 5 e pelo menos um produto ou
segmento em comum; **Média** ≥ 3; **Baixa** > 0; senão **Sem afinidade**.
`status` é `NO_PROFILE` sem perfil preenchido e `NOT_CLASSIFIED` enquanto a lei
não foi classificada.

## Catálogos oficiais

| Catálogo | Fonte | Carga |
|---|---|---|
| NCM | Portal Único Siscomex (JSON) | botão na curadoria: conferir → carregar |
| CNAE 2.3 | API IBGE `servicodados` | botão na curadoria: conferir → carregar |
| cClassTrib/CST | Tabela oficial do Informe Técnico 2025.002 (CSV) | upload na curadoria |

A API automática do Conformidade Fácil exige certificado ICP-Brasil; até lá o
cClassTrib entra por arquivo. Cada carga cria nova edição `CURRENT` e
supersede a anterior; a curadoria conferirá códigos contra a edição vigente.

## Perfil Tributário

`/api/v1/taxonomy/profile-options` devolve só dimensões/itens visíveis, na
ordem configurada, com grupos e ajuda, e `conceptCodes` com todos os itens da
release (itens ocultos continuam salváveis). `/api/v1/companies/:id/taxonomy-suggestions`
sugere segmentos pelo CNAE (prefixo mais específico vence; CNAE principal
pré-marca, secundários sugerem).

## Carga da planilha de produtos (Segmento;Grupo;Item)

`npm run taxonomy:load-products -- --file=ops/taxonomy/loads/<planilha>.csv [--confirm]` carrega a planilha do PO na tabela de Produtos do rascunho aberto. A lógica fica em `curation.product-load.ts`. A planilha é tratada como a fonte mais atualizada:

- **Item que já existe:** é atualizado. Conta como existente o mesmo nome (ignorando maiúsculas, acentos e singular/plural) ou um de seus sinônimos. O item recebe o nome e o grupo da planilha, e o nome anterior vira sinônimo.
- **Item novo:** é criado no grupo da planilha. O grupo é criado se não existir.
- **Segmento:** os grupos da planilha são vinculados ao segmento informado (item do Setor com o mesmo nome).
- **Item repetido na planilha:** vale a última linha.
- **Sem `--confirm`:** tudo é executado e desfeito (simulação). Se houver erro, nada é gravado. Nada é publicado: o curador revisa o rascunho antes.
