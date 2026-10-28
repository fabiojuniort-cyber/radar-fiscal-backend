# ANAT-CONFIG-01 — configuração acessível da anatomia

Issue de governança: tribusca-control#116. Decisão do COORD de 28/10/2026:

- **"Salvar configuração" valida e aplica a configuração em produção numa única ação administrativa.**
- O salvamento não tem congelamento, nem revisão por um segundo administrador, nem publicação posterior.
- Isso substitui, neste fluxo, a dupla aprovação da migration 079.
- O salvamento só afeta as **novas** análises. Nada do acervo é reprocessado.

Web: radar-fiscal-web, tela `/admin/anatomia` (documentada em `docs/ANAT_CONFIG_01.md` daquele repositório).

## 1. Estado das duas entregas

| Entrega | Estado |
|---|---|
| Implementação: backend, banco, consumidor, web, testes | Concluída nos PRs fabiojuniort-cyber/radar-fiscal-backend#276 e fabiojuniort-cyber/radar-fiscal-web#135. Desligada por padrão. |
| Anatomia inicial baseada em atos oficiais (8 a 12 atos) | **BLOQUEADA** por acesso de rede (ver §2). Hoje a tela usa 6 atos **sintéticos**, identificados como tal. |

## 2. Bloqueio exato das fontes oficiais

Tentativas feitas em 28/10/2026 nesta sessão, com ferramentas autorizadas e sem túnel ou proxy alternativo:

| Ferramenta | Host | Erro |
|---|---|---|
| WebFetch | www.planalto.gov.br | `getaddrinfo ENOTFOUND` (fora dos domínios permitidos da sessão) |
| WebFetch | normas.receita.fazenda.gov.br | `getaddrinfo ENOTFOUND` |
| WebFetch | legis.senado.leg.br | `getaddrinfo ENOTFOUND` |
| curl (proxy da sessão) | www.planalto.gov.br, normas.receita.fazenda.gov.br, www.confaz.fazenda.gov.br, legislacao.fazenda.sp.gov.br, www.in.gov.br, legis.senado.leg.br | `connect_rejected` (o proxy de saída recusou o CONNECT) |
| WebSearch | busca geral | Só devolveu cópias de terceiros (legjur, justia) e a ficha de catálogo do Senado. **Não foram usadas como evidência.** |

**Para desbloquear,** os hosts acima precisam ser liberados na configuração de rede do ambiente (Network access → Allowed domains).

**Quando houver acesso,** o trabalho segue estes passos:

1. Escolher e consultar, um a um, de 8 a 12 atos.
2. Registrar de cada ato a URL, a data de consulta, a identificação da versão e o motivo da escolha.
3. Incluir os atos em `OFFICIAL_SAMPLES` (`src/modules/anatomy/config/config.service.ts`), no formato `SampleInput` com `provenance.kind = 'official'`.
4. Escrever as anotações com evidência e segunda conferência.
5. Rodar os testes.

A tela já mostra a procedência de cada ato. Nenhum conteúdo de corpus, gold ou reserva foi consultado; os IDs reservados são recusados por teste.

## 3. Anatomia preparada pela IA (amostra sintética)

- **Arquivos:** `src/modules/anatomy/config/sample-inputs.ts` (atos) e `sample-annotations.ts` (leitura da IA).
- **Cobertura:** estilos do CONFAZ, redação anterior, nota de alteração, texto citado com (NR), retificação, tabela com coluna NCM, faixa e exceção de NCM, texto corrido do DOE-SP e um estilo de nota fora da configuração de fábrica.
- **Três dimensões separadas:**
  - **estrutura:** epígrafe, cláusula, artigo, anexo…;
  - **natureza:** dispositivo do ato, redação anterior, nota editorial, texto que altera outro ato, elemento estrutural ou a conferir;
  - **vigência:** fica "não determinada" salvo quando o próprio texto a declara. Notas como "Acrescentado pelo…" ou "Nova redação dada…" **não decidem sozinhas** a vigência do dispositivo. Há teste para isso.
- **Ambiguidades sinalizadas, sem classificação inventada:**
  - assinatura com o mesmo estilo do corpo;
  - bloco "Na Portaria …" de retificação;
  - epígrafe sem estilo;
  - texto corrido do DOE-SP, que é limitação do motor.
- **Segunda conferência:** foi feita pela mesma sessão de IA. **Não é revisão independente** e não transforma a amostra em gold. Divergências registradas:
  1. Na cláusula com redação anterior do convênio, a vigência passou de "não determinada" para "substituída", só nesse trecho histórico.
  2. No Art. 2º da IN fictícia, a releitura identificou faixa de códigos (8471.30.11 a 8471.30.13). O motor também não marca essa faixa; o caso fica na conferência.

## 4. Consumidores da configuração

`analyzeWithActiveConfiguration(client, request)` (`config.service.ts`) é o ponto único de consumo. Ele lê a versão em vigor na mesma transação e grava a versão na identidade da análise (`ruleSet = anatomy-config / <versão>`).

Hoje a configuração salva é consumida por:

- **a análise da tela** (`POST /analysis`), que usa a versão em vigor como "antes";
- **qualquer chamada a `analyzeWithActiveConfiguration`**, provada no teste de integração com o papel `radar_worker`.

Não há processamento em lote de anatomia no código: nada grava `publication_anatomies` e `anatomy_runs`. Por isso **salvar não muda nenhuma publicação nem análise armazenada**, e a tela diz isso. Um processamento futuro deve usar esta função; não deve ler perfis por conta própria.

## 5. Contratos alterados

- **Migration `081_anat_config_direct_apply.sql`** (numeração conferida com a main faa019c4; nenhum branch aberto usa 081):
  - `anatomy_config_versions` são imutáveis (UPDATE e DELETE dão `anat:IMMUTABLE`);
  - `anatomy_config_current` é um ponteiro único e só avança;
  - as entradas `anat_config_save`, `anat_config_restore` e `anat_config_audit_attempt` são SECURITY DEFINER, pertencem a `anat_rules_writer`, têm search_path fixo e exigem administrador de plataforma (`anat_actor`);
  - concorrência: lock consultivo, `FOR UPDATE` e `expected_version`; a divergência devolve `STALE_VERSION` (409), que é auditado;
  - a versão, o ponteiro e a auditoria vão na mesma transação, então qualquer falha mantém a versão anterior;
  - RLS: `radar_app` lê só se for administrador de plataforma, `radar_worker` lê, e PUBLIC e o curador não têm acesso;
  - a política de auditoria estende **exatamente** a da 078 com `ANAT_RULES_CONFIG_SAVED` e `ANAT_RULES_CONFIG_REJECTED`, com o mesmo bloqueio fail-closed caso a política em vigor seja diferente;
  - as migrations aplicadas não foram alteradas.
- **Substituição da dupla aprovação:** com `ANAT_CONFIG_ENABLED=true`, as rotas da 079 (`/api/v1/admin/anatomy-rules`) **não são registradas**, e o web redireciona `/admin/anatomia-regras`. As tabelas e funções da 079 ficam como histórico. Nada lê ativações da 079.
- **API `/api/v1/admin/anatomy-config`:**
  - `GET` mostra a configuração, o catálogo e os atos;
  - `GET /versions` e `GET /versions/:id`;
  - `POST /analysis`, `POST /suggestions`, `POST /save` e `POST /restore`;
  - `GET /audit`.
- **Proteções preservadas:**
  - o validador do motor (piso e teto de proteções, limites, conflitos) roda antes da prévia e antes de salvar;
  - o executor isolado roda a prévia;
  - o isolamento entre tenants não muda (eventos globais, `tenant_id` NULL);
  - RESTRICT não foi removido.

## 6. Matriz requisito → implementação → teste → limitação

| Requisito | Implementação | Teste | Limitação |
|---|---|---|---|
| Anatomia inicial preenchida pela IA, com referências | `sample-inputs.ts`, `sample-annotations.ts` | unit "samples are synthetic, annotated…" | Só sintética; oficial bloqueada (§2) |
| Estrutura, natureza e vigência separadas; nota não decide vigência | `view.ts` | unit "describeResult…"; e2e passo 2 | Vigência do motor é sempre "unknown" hoje |
| Ambiguidade sinalizada, sem inventar | `ambiguity` + lista de conferência | unit; e2e passo 9 | — |
| Segunda conferência explícita, divergências documentadas | `secondCheck` | unit (campo obrigatório) | Não é revisão independente |
| Ato e estrutura relacionados | web: árvore ↔ texto | e2e passo 2 (`aria-current`) | — |
| Correção de trecho separada de regra para semelhantes | `corrections` (versionadas) vs `changes` | unit "corrections…"; vitest; e2e passo 3 | Correção é expectativa; não muda o processamento |
| Alcance explícito (padrão geral, fonte, família) | `Scope` em `rules.ts`; seletor na tela | unit "guided change…" | Escopo "documento" só como correção |
| Prévia antes/depois com contagens reais | `analyze()` no executor isolado | integração "analysis…"; e2e passo 4 | Contagens sobre os atos da amostra |
| Desfazer edição; restaurar versão | desfazer por item; `anat_config_restore` | vitest; integração "restore…"; e2e passos 3 e 8 | — |
| Lista de conferência explicada | `ReviewItem` | unit; e2e passo 9 | — |
| Entrada no menu administrativo | link "Anatomia dos atos" | e2e (navegação), build com e sem flag | Só com flag |
| Sem JSON obrigatório | mudanças guiadas | e2e (`textarea` = 0); vitest | — |
| Mensagens específicas | `validateConfiguration`, `applyChanges`, `MESSAGES` | unit "specific messages…"; integração "validation…"; e2e passo 5 | — |
| Só administradores | `requirePlatformAdmin` + `anat_actor` + RLS | integração "authorisation…"; e2e passo 0 | — |
| Validar antes de aplicar; aplicação atômica | TS + `anat_config_write` | integração "validation…" e "save…" | — |
| Edições concorrentes | lock + `expected_version` | integração "concurrency…"; e2e passo 7 | — |
| Histórico de versões e auditoria; restauração auditada | `anatomy_config_versions` + audit | integração "restore…"; e2e (`/__dev-state`) | — |
| Falha mantém a versão anterior | transação única | integração "a persistence failure…" | — |
| Consumidor usa a configuração salva | `analyzeWithActiveConfiguration` | integração "save…" (worker; ruleSet = versão; nota vira `editorial_note`) | Não há lote de anatomia no código |
| Acervo preservado | sem escrita fora das tabelas de configuração | integração "nothing stored is reprocessed…" | — |
| Dupla aprovação substituída | rotas da 079 não registradas | integração "legacy … not registered"; privilégios em admin-schema | Tabelas da 079 permanecem como histórico |
| Desligada por padrão | `ANAT_CONFIG_ENABLED`, `VITE_ENABLE_ANAT_CONFIG` | integração "flag off"; vitest da flag | — |
| PG16/PG18 | matriz `anatomy-admin-migrations` (+ `config`) | CI | — |

## 7. Plano de implantação (não autorizado neste lote)

1. Revisão técnica independente dos dois PRs; merge só com autorização do COORD.
2. **Backend:**
   - o merge na main faz o deploy automático, e o pré-deploy `db:prepare` aplica a 081;
   - antes, conferir que a política de auditoria em produção é a da 078; se não for, a 081 recusa e nada muda;
   - backup pgBackRest recente confirmado.
3. Conferir: health 200 com database up e `GET /api/v1/admin/anatomy-config` = 404 (flag desligada).
4. Ligar `ANAT_CONFIG_ENABLED=true` (backend). Com o backend nessa mudança, a rota antiga deixa de existir. Conferir 401 sem token e 403 para não-admin.
5. Ligar `VITE_ENABLE_ANAT_CONFIG=true` (web; vale no build). Abrir a tela com um administrador.
6. O primeiro salvamento cria a versão 1. Antes dele vale a configuração de fábrica (versão 0).

## 8. Recuperação

- **Configuração ruim:** usar "Restaurar esta versão" no histórico. Isso cria uma nova versão com o conteúdo anterior, aplicada na hora e auditada.
- **Voltar ao comportamento de fábrica:** restaurar uma versão salva com os perfis de fábrica. Desligar a flag só esconde a tela e a API: a versão em vigor continua sendo lida pelo consumidor.
- **Desligar:** `ANAT_CONFIG_ENABLED=false` (rotas 404) e `VITE_ENABLE_ANAT_CONFIG=false` (tela oculta). Nenhum dado é apagado.
- **Migration:** é aditiva. Não há rollback destrutivo previsto. As tabelas ficam mesmo com a flag desligada.

## 9. Roteiro de uso (administrador)

1. Menu do usuário → **Anatomia dos atos**.
2. Escolher um ato no topo e clicar num trecho: ver estrutura, natureza, vigência, o porquê e a leitura da IA.
3. Se só aquele trecho está errado: **Corrigir só este trecho**.
4. Para tratar casos parecidos: **Criar regra para trechos semelhantes** → **Ver sugestão** → escolher o alcance → **Adicionar à proposta**. Também dá para usar a aba **Regras** (tipo, alcance, texto; × para retirar).
5. **Testar alterações:** conferir quantos trechos mudam e os casos a conferir antes → depois. Use **Antes/Depois** para comparar.
6. **Salvar configuração** → **Confirmar e salvar**. A configuração passa a valer para as novas análises.
7. Para voltar atrás: aba **Histórico** → **Restaurar esta versão**.
