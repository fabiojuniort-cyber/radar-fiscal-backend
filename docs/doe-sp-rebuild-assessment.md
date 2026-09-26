# DOE-SP — avaliação de reconstrução do acervo sob política page-first

**Atividade:** DOE-SP-24  
**Estado:** análise/preparação; nenhuma operação produtiva executada.  
**Política:** D-017 atualizada / page-first.

## 1. Evidência produtiva somente leitura disponível

Snapshots já produzidos por auditorias read-only em produção registraram:

- source DOE-SP: `46e9ea3c-83c0-4ce0-8bb1-eca2c8a890c2`;
- 517 publicações;
- 517 versões;
- 0 versões históricas no snapshot;
- 4.416.897 caracteres de texto;
- 0 versões com `content_text` vazio;
- 610 entradas de arquivo no metadata das versões;
- 516 `AUTHENTICATED_PUBLICATION_PDF`;
- 94 `ATTACHMENT`;
- 610/610 arquivos com SHA-256 válido e tamanho;
- 341.520.754 bytes de arquivos;
- 317 identidades `STRONG`;
- 200 identidades `SOURCE_SCOPED`;
- nenhuma duplicidade de `external_id` observada;
- nenhuma identidade DOE com múltiplos `external_id` observada naquele snapshot;
- checkpoint geração 22, cobertura desde 2025-01-01, com faixa pendente histórica 2025-07-29 → 2026-08-31.

O fato de 517/517 versões terem `content_text` não vazio demonstra que o acervo atual possui corpo textual capturado para todas as publicações do snapshot. Isso é forte evidência para page-first, mas não prova por si só que cada página continua hoje disponível e integral.

Os 94 attachments são material independente e **não podem ser descartados** por uma reconstrução.

Caso real:
- `b8bec255-a9b3-44c0-1648-08dd40ce108a`: 889.241 caracteres de texto e PDF nunca renderizado pela fonte; HTML preservou o conteúdo.
- Portaria SRE 42/2025: duas representações oficiais com mesmo HTML normalizado; uma origem tinha PDF 404 e outra PDF disponível. Sob DOE-SP-24 nenhum dos PDFs redundantes deve ser solicitado quando o HTML oficial estiver completo.

## 2. Lacuna atual da evidência

O conector Railway disponível nesta sessão não fornece execução SQL ad hoc. Portanto **não existe nesta atividade uma nova leitura individual dos 517 IDs** com os vínculos atuais de tenant/company, compartilhamento cross-source e audit log.

Não é seguro inferir esses dados a partir de amostras.

Para fechar essa lacuna, o PR adiciona o comando read-only:

`npm run db:audit-doe-sp-rebuild`

Implementação:
`src/infrastructure/database/audit-doe-sp-rebuild.ts`

O auditor:
- abre `BEGIN READ ONLY`;
- não executa INSERT/UPDATE/DELETE;
- emite uma linha por publication ID;
- relaciona external IDs, origin IDs e URLs;
- versões/current hash;
- arquivos por classificação;
- `publication_files`;
- `company_publications`;
- tenants via `companies.tenant_id`;
- `publication_matches`;
- `collection_items`;
- `collection_run_publications`;
- links para runs de outras fontes;
- origens de outras fontes;
- referências diretas em `audit_log.entity_id`;
- checkpoints e runs ativos.

Esse comando foi preparado, mas **não foi executado em produção nesta atividade**.

## 3. Classificação necessária antes da reconstrução

Para cada um dos 517 IDs, o preflight deve produzir uma das classes:

### HTML_BODY_CANDIDATE

- `content_text` atual não vazio;
- nenhum attachment material.

Nova captura esperada:
- HTML/JSON oficial;
- zero tentativa de PDF redundante.

### HTML_PLUS_MATERIAL_ATTACHMENTS

- `content_text` atual não vazio;
- um ou mais `ATTACHMENT`.

Nova captura esperada:
- HTML oficial para corpo principal;
- zero tentativa de PDF redundante;
- todos os attachments materiais baixados e validados.

### PDF_FALLBACK_CANDIDATE

- página atual sem corpo oficial suficiente.

Nova captura esperada:
- PDF oficial obrigatório como `MATERIAL_CONTENT`;
- falha do PDF mantém item incompleto.

No snapshot existente, `empty_text = 0`, portanto não há evidência de PDF-only entre os 517 registros persistidos. A classificação individual ainda precisa ser confirmada no preflight.

## 4. Dependências do schema

### Publicações

`publication_origins.publication_id -> publications(id) ON DELETE CASCADE`.

### Versões

`publication_versions.publication_id -> publications(id) ON DELETE CASCADE`.

### Arquivos persistidos

`publication_files.publication_version_id -> publication_versions(id) ON DELETE CASCADE`.

No snapshot DOE-SP, o audit registrou `publication_file_id = null` no caso SRE 42 e o audit agregado de arquivos deriva principalmente de `source_metadata.files`; ainda assim `publication_files` deve ser contado individualmente antes de reconstruir.

### Histórico de runs

`collection_run_publications.publication_id -> publications(id) ON DELETE CASCADE`.

Runs e attempts não precisam ser apagados; os vínculos publication↔run seriam removidos se a publicação fosse removida.

### Collection items

`collection_items.publication_id -> publications(id)` **sem ON DELETE CASCADE**.

Qualquer reconstrução que remova publications precisa primeiro tornar esses vínculos nulos, preservando os próprios items/runs.

### Tenant/company

`company_publications.publication_id -> publications(id) ON DELETE CASCADE`.

`publication_matches -> company_publications ON DELETE CASCADE`.

Uma reconstrução destrutiva fica **bloqueada** se houver qualquer `company_publications` ou `publication_matches` sem plano explícito de preservação/reassociação.

### Cross-source

Uma publicação pode teoricamente possuir origins de mais de uma fonte. Qualquer target com origin externo ao DOE-SP bloqueia a estratégia de apagar a publication inteira.

### Checkpoints

`collection_checkpoints.source_id -> sources(id)`.

Para reconstruir desde o início, checkpoints DOE-SP precisam ser exportados e depois resetados/removidos somente na operação autorizada.

### Audit log

`audit_log.entity_id` é texto, sem FK para publications.

Excluir/recriar publication IDs não apaga o audit log, mas pode deixar referências sem alvo atual. O preflight precisa contar/exportar essas referências e o backup deve preservar um mapa `oldPublicationId -> identity_hash/external_id`.

## 5. Evidência histórica do processo de sanitização

Antes do acervo atual, uma sanitização DOE-SP foi executada quando existiam 32 publicações.

O dry-run registrado então mostrou:
- publications: 32;
- versions: 32;
- origins: 32;
- companyPublications: 0;
- publicationMatches: 0;
- sharedWithOtherSources: [];
- foreignRunLinks: 0;
- collectionItemsReferencing: 52;
- checkpoints: 3;
- runs/attempts/items preserváveis.

A execução histórica:
- desvinculou 52 collection items;
- removeu 32 publications/origins;
- removeu 3 checkpoints;
- preservou runs, attempts e items.

Isso prova que existe um padrão técnico já usado, **mas não prova que o acervo atual de 517 continua sem vínculos tenant/cross-source**.

## 6. Caminho A — reconstruir o acervo DOE-SP

### Pré-condições obrigatórias

Antes de autorização destrutiva:

1. auditor read-only executado no estado imediatamente anterior;
2. lista exata dos 517+ IDs alvo e SHA do manifesto;
3. `companyRefs = 0`;
4. `tenantRefs = 0`;
5. `matchRefs = 0`;
6. `sharedPublications = 0`;
7. `foreignRunRefs = 0`;
8. nenhuma run DOE-SP PENDING/RUNNING;
9. scheduler DOE-SP pausado;
10. referências de `audit_log` exportadas/mapeadas;
11. backup validado.

Se qualquer condição 3–7 falhar, não usar o sanitizador destrutivo histórico sem novo desenho.

### Backup verificável

Antes da operação:

- snapshot/backup PostgreSQL verificado e com procedimento de restore testável;
- export lógico dos targets:
  - `publications`;
  - `publication_origins`;
  - `publication_versions`;
  - `publication_files`;
  - `collection_run_publications`;
  - referências de `collection_items`;
  - `company_publications` e `publication_matches`;
  - `collection_checkpoints`;
  - referências `audit_log`;
- manifesto por ID contendo identity_hash, external IDs, URLs, hashes e contagens;
- SHA-256 de cada export/manifesto.

### Reconstrução

Somente após novo gate/autorização:

1. pausar agendamento;
2. confirmar ausência de runs ativas;
3. repetir preflight e comparar token/manifesto;
4. abrir transação serializable;
5. desvincular `collection_items.publication_id` dos targets;
6. remover origins/publications DOE-SP e checkpoints conforme plano aprovado;
7. commit apenas se pós-condições baterem;
8. executar o conector já page-first desde 2025-01-01;
9. não baixar PDFs redundantes;
10. baixar attachments materiais;
11. usar PDF material somente onde o corpo oficial estiver realmente ausente.

### Validação

Após reconstrução:

- contagem esperada de publicações reconciliada por external ID/identity;
- zero duplicidades de origin/identity;
- zero `AUTHENTICATED_PUBLICATION_PDF` redundante em publicações HTML-first;
- attachments esperados presentes com SHA/tamanho;
- qualquer PDF capturado justificado como `MATERIAL_CONTENT`;
- zero `NEW_VERSION` artificial dentro do acervo recém-construído;
- checkpoint/coverage reconstruídos;
- runs/attempts históricos preservados conforme plano;
- manifesto antigo↔novo reconciliado.

### Reversão

- falha antes do COMMIT: rollback transacional;
- falha após sanitização/rebuild: pausar scheduler e restaurar o backup PostgreSQL validado;
- conferir novamente manifesto, tenant refs, checkpoints e contagens antes de reativar.

## 7. Caminho B — preservar o acervo

Manter os 517 registros atuais e:

1. conservar compatibilidade v1→v2;
2. corrigir `upsertOrigin()` para não apagar evidência anterior da mesma origem durante replay degradado;
3. garantir merge de metadata que preserve proveniência anterior e registre o diagnóstico atual;
4. manter IDs/versões/referências tenant existentes;
5. validar `CAPTURED -> falha -> recuperação`.

Vantagem: menor risco de quebrar referências existentes.

Custo: mantém complexidade de transição v1→v2 e legado de PDFs redundantes.

## 8. Comparação e recomendação

### A elimina a compatibilidade v1→v2?

**Sim, para o corpus DOE-SP reconstruído**, se o preflight comprovar que todas as versões legadas alvo foram removidas e o rebuild parte limpo sob a nova política.

Não elimina:
- necessidade de versionar attachments materiais;
- comportamento conservador quando uma página futura exigir PDF material;
- problemas equivalentes em outras fontes.

### A elimina o mecanismo de preservação do DOE-SP-23?

**Não integralmente.**

A reconstrução page-first elimina o caso específico em que um **PDF redundante legado** precisa ser preservado: novos registros com HTML completo não baixam esse PDF.

Porém o DOE-SP ainda admite **PDF material** quando a página oficial não trouxer o corpo necessário. Se a mesma origem:
1. for capturada primeiro por PDF material; e
2. em replay futuro passar a oferecer HTML integral,

a observação HTML não terá arquivo novo e um overwrite integral de `publication_origins.metadata` poderia apagar a evidência do PDF material antes capturado.

Por isso a preservação de arquivos já capturados **da mesma origem** continua necessária nos dois caminhos. O PR foi ajustado para preservar `files` anteriores quando a observação atual da mesma origem não fornece nova lista de arquivos, enquanto status/diagnóstico atuais continuam vencendo. Isso não transfere arquivos entre origens.

Consequência:
- **A/rebuild** pode eliminar a compatibilidade v1→v2 para o corpus reconstruído em HTML, mas **não elimina** a regra de preservação de proveniência da mesma origem;
- **B/preservar** precisa de ambas: compatibilidade v1→v2 e preservação de origem.

### Caminho recomendado

**Recomendação condicional: Caminho A**, porque:
- o acervo ainda é inicial;
- há 0 versões históricas no snapshot;
- 517/517 versões possuem texto;
- 516 downloads redundantes podem ser eliminados;
- a solução final DOE-SP fica mais limpa, sem compatibilidade v1→v2 para os registros reconstruídos em HTML.

A agora **também mantém** a proteção de proveniência same-origin para PDFs materiais, porque essa necessidade não depende do legado.

Entretanto A **não está autorizado nem suficientemente provado ainda**. A decisão de executar deve ocorrer somente depois de rodar o novo audit read-only e confirmar zero vínculos tenant/company, zero compartilhamento cross-source e zero blockers.

Se qualquer desses blockers existir, a recomendação muda para **Caminho B** ou para uma reconstrução ID-preserving desenhada especificamente para manter essas referências.
