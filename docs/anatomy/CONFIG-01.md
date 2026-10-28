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

## 4. Consumidores da configuração (revisão R2)

**Serviço único:** `configuredAnalysis(executor, {profiles, corrections}, documento)` em `src/modules/anatomy/config/config.service.ts`.
- Roda o motor no executor isolado (`SimulationExecutor.analyze`) com os perfis da configuração.
- Depois aplica as correções de trecho **sobre** o resultado (`view.ts`, `describeResult`).
- O resultado original do motor não é alterado; o serviço devolve as duas coisas.

Esse serviço é usado por dois caminhos:
1. **Prévia da tela** (`POST /analysis`). O lado "antes" usa a configuração em vigor (perfis e correções); o lado "depois" usa a proposta.
   - Correção de afirmação anterior: na versão `c1f0f054` esse caminho lia os perfis em vigor, mas **não** chamava um serviço compartilhado nem aplicava correções. Agora chama `configuredAnalysis`.
2. **Consumidor real: nova análise de um documento** (`POST /documents/:id/analyses`, botão "Nova análise deste documento").
   - `analyzeWithActiveConfiguration` lê a versão em vigor e chama `configuredAnalysis`.
   - Registra a análise em `anatomy_config_analyses` com o documento, a versão do documento (hash), a versão da configuração e as correções aplicadas ou desatualizadas.
   - A tabela é imutável; análises anteriores ficam preservadas e são listadas por documento.
   - Se a configuração mudar durante a análise, nada é registrado (`STALE_VERSION`).
   - Auditoria: `ANAT_RULES_CONFIG_ANALYZED`.

Não existe processamento em lote, coleta automática nem reprocessamento. Nada grava `publication_anatomies` nem `anatomy_runs`. As análises são individuais, disparadas pela tela, e só sobre os documentos da amostra.

**Correção pontual (alcance documento):**
- Fica vinculada a `documentId`, a `documentHash` (SHA-256 da versão exata) e a `partKey` (SHA-256 de documento + texto próprio do trecho). Não usa posição na tela.
- Ao salvar, o servidor define autor (usuário da sessão), data e versão. A 081 recusa uma correção nova com outro autor (`ACTOR_MISMATCH`).
- **Outro documento** nunca recebe a correção.
- **Mesmo documento, outra versão** (hash diferente) ou **trecho inexistente:** a correção é marcada como desatualizada, não é aplicada e aparece na conferência.
- Salvar e restaurar carregam as correções junto com os perfis. Uma correção nunca vira regra.

## 5. Contratos alterados

- **Migration `081_anat_config_direct_apply.sql`** (numeração conferida com a main faa019c4; nenhum branch aberto usa 081; aplicada só em bancos descartáveis, por isso editável até o merge):
  - `anatomy_config_versions` são imutáveis (UPDATE e DELETE dão `anat:IMMUTABLE`). Guardam perfis e correções de trecho;
  - `anatomy_config_current` é um ponteiro único e só avança;
  - `anatomy_config_analyses` registra as novas análises de um documento. É imutável e só aceita a versão em vigor (`STALE_VERSION`);
  - **quatro entradas** SECURITY DEFINER, com owner `anat_rules_writer`, search_path fixo e exigência de administrador de plataforma (`anat_actor`):
    - `anat_config_save`;
    - `anat_config_restore`;
    - `anat_config_record_analysis`;
    - `anat_config_audit_attempt`;
  - **concorrência:**
    - salvar e restaurar tomam o lock consultivo `anat-config` em modo exclusivo, mais `FOR UPDATE` e `expected_version`. A divergência devolve `STALE_VERSION` (409), que é auditado;
    - o registro de análise toma o **mesmo lock em modo compartilhado**. Isso serializa o registro com salvamentos também antes do primeiro salvamento, quando não há linha para travar (CONFIG-R2-03);
  - **correções:** a 081 confere o formato e recusa, ao salvar, uma correção nova cujo autor não seja o usuário da sessão (`ACTOR_MISMATCH`);
  - a versão, o ponteiro e a auditoria vão na mesma transação, então qualquer falha mantém a versão anterior;
  - **RLS:** `radar_app` lê só se for administrador de plataforma, `radar_worker` lê, e PUBLIC e o curador não têm acesso;
  - a política de auditoria estende **exatamente** a da 078 com **três eventos**: `ANAT_RULES_CONFIG_SAVED`, `ANAT_RULES_CONFIG_REJECTED` e `ANAT_RULES_CONFIG_ANALYZED`. O bloqueio fail-closed atua caso a política em vigor seja diferente;
  - as migrations aplicadas não foram alteradas.
- **Substituição da dupla aprovação:** com `ANAT_CONFIG_ENABLED=true`, as rotas da 079 (`/api/v1/admin/anatomy-rules`) **não são registradas**, e o web redireciona `/admin/anatomia-regras`. As tabelas e funções da 079 ficam como histórico. Nada lê ativações da 079.
- **API `/api/v1/admin/anatomy-config`** (só administradores de plataforma):
  - `GET /`: configuração em uso (regras em português, correções com autor), catálogo e atos;
  - `GET /versions` e `GET /versions/:id`;
  - `POST /analysis`: prévia antes/depois, pelo serviço compartilhado; devolve `basedOnVersion`;
  - `POST /suggestions`;
  - `POST /save`: `basedOnVersion` deve ser a versão do teste; a tela envia a versão devolvida pela prévia (CONFIG-R2-02);
  - `POST /restore`;
  - `POST /documents/:sampleId/analyses`: nova análise registrada;
  - `GET /documents/:documentId/analyses`: análises registradas do documento;
  - `GET /audit`.
- **Identidade do trecho** (CONFIG-R2-01): é o documento, o texto próprio do trecho e o **número da ocorrência** desse texto na ordem do documento. Dois trechos idênticos ("Assinatura" duas vezes) têm chaves diferentes. Uma chave ambígua é recusada (`ambiguous_passage`) e nunca adivinhada.
- **Proteções preservadas:**
  - o validador do motor (piso e teto de proteções, limites, conflitos) roda antes da prévia e antes de salvar;
  - o executor isolado roda as análises;
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
| Correção de trecho separada de regra para semelhantes | `corrections` (versionadas) vs `changes` | unit "corrections: applied…"; vitest; e2e passos 3 e 4 | — |
| Correção aplicada ao resultado, preservando o original; vinculada à versão e ao trecho; desatualizada sinalizada | `describeResult` (overlay), `documentHash`, `passageKey`, `prepareCorrections`, 081 (formato + autor) | unit; integração "the real consumer AFTER save…", "correction input…"; e2e passos 7–9 | Identidade = documento + texto próprio + ocorrência; mudar o documento torna a correção desatualizada |
| Resultado original, correção, autor, motivo e versão mostrados à parte | painel "Trecho" (Resultado do motor + Correção administrativa aplicada) | vitest; e2e passo 7 | — |
| Alcance explícito (padrão geral, fonte, família) | `Scope` em `rules.ts`; seletor na tela | unit "guided change…" | Escopo "documento" só como correção |
| Prévia antes/depois com contagens reais | `analyze()` no executor isolado | integração "analysis…"; e2e passo 4 | Contagens sobre os atos da amostra |
| Desfazer edição; restaurar versão | desfazer por item; `anat_config_restore` | vitest; integração "restore…"; e2e passos 3 e 8 | — |
| Lista de conferência explicada | `ReviewItem` | unit; e2e passo 9 | — |
| Entrada no menu administrativo | link "Anatomia dos atos" | e2e (navegação), build com e sem flag | Só com flag |
| Sem JSON obrigatório | mudanças guiadas | e2e (`textarea` = 0); vitest | — |
| Mensagens específicas | `validateConfiguration`, `applyChanges`, `MESSAGES` | unit "specific messages…"; integração "validation…"; e2e passo 5 | — |
| Só administradores | `requirePlatformAdmin` + `anat_actor` + RLS | integração "authorisation…"; e2e passo 0 | — |
| Validar antes de aplicar; aplicação atômica | TS + `anat_config_write` | integração "validation…" e "save…" | — |
| Edições concorrentes | lock + `expected_version` | integração "concurrency…"; e2e passo 10 | — |
| Trechos com texto repetido (CONFIG-R2-01) | ocorrência no `passageKey`; recusa de identidade ambígua | unit "CONFIG-R2-01…" (falha sem a correção) | — |
| Teste vinculado à versão-base (CONFIG-R2-02) | assinatura do teste inclui a versão; salvar envia `basedOnVersion` da prévia; aviso e bloqueio quando a base muda | vitest "CONFIG-R2-02…" (falha sem a correção) | — |
| Registro de análise × primeiro salvamento (CONFIG-R2-03) | lock consultivo compartilhado em `anat_config_record_analysis` | integração "CONFIG-R2-03…", nos dois sentidos (falha sem a correção) | — |
| Histórico de versões e auditoria; restauração auditada | `anatomy_config_versions` + audit | integração "restore…"; e2e (`/__dev-state`) | — |
| Falha mantém a versão anterior | transação única | integração "a persistence failure…" | — |
| Consumidor real na interface, mesmo serviço da tela | `configuredAnalysis` + `POST /documents/:id/analyses` + `anatomy_config_analyses` | integração "the real consumer BEFORE/AFTER save…", "version 2…", "restore…"; vitest; e2e passos 2, 7–11 | Só análises individuais da amostra; sem lote |
| Restauração recupera o comportamento anterior | `anat_config_restore` (perfis + correções) | integração "restore…" (nova análise v3 aplica a correção de novo); e2e passo 11 | — |
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
3. Se só aquele trecho está errado: **Corrigir só este trecho**, escolhendo o que ele é e informando o motivo.
4. Para tratar casos parecidos: **Criar regra para trechos semelhantes** → **Ver sugestão** → escolher o alcance → **Adicionar à proposta**. Também dá para usar a aba **Regras** (tipo, alcance, texto; × para retirar).
5. **Testar alterações:** conferir quantos trechos mudam e os casos a conferir antes → depois. Use **Antes/Depois** para comparar.
6. **Salvar configuração** → **Confirmar e salvar**. A configuração passa a valer para as novas análises.
7. Para ver o efeito num documento: **Nova análise deste documento**. A análise fica registrada com a versão usada.
8. Para voltar atrás: aba **Histórico** → **Restaurar esta versão**.
