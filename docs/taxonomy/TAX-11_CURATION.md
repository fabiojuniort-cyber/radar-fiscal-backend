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
`curation.constants.ts`, que reproduzem o comportamento antes da TAX-11.

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
  escopo. Remover a exclusão só após o fechamento formal do DOE-SP.
- O Worker roda `processPublicationTaxonomyBatch` após a detecção de NCM
  (20 por ciclo ocioso, 10 após cada coleta), mais recentes primeiro.
- Selo: `publication_taxonomy_scans` por versão × release × motor. Sem selo
  `SUCCESS` = pendente; publicar nova release ou mudar o motor reenfileira o
  acervo inteiro (legado incluso) sem apagar histórico. Falhas são retentadas
  até 3 vezes (intervalo de 15 min).
- Sinais: nome do item (se `classify_by_label`), sinônimos
  `EXACT_LEXICAL`/`ABBREVIATION`, prefixo NCM contra menções NCM detectadas e
  cClassTrib citado no texto. Cada tag guarda o trecho/termo que a gerou.

## Tags na legislação

- `GET /api/v1/publications/:id/taxonomy` — seções configuradas, motivo de cada
  tag, status (`CLASSIFIED`, `PENDING`, `DISABLED`, `EXCLUDED`, `FAILED`).
- `GET /api/v2/archive?tag=<código>` — Acervo filtrado por tag efetiva.
- Curador: `POST /api/v1/admin/taxonomy/publications/:id/tags`
  (`ADD`/`REMOVE`/`RESTORE`). Remover tag automática grava `REJECT` em
  `publication_taxonomy_reviews`; tags manuais usam
  `publication_taxonomy_curator_tags` (append-only).

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
