# TAX-10 — publicação explícita da Taxonomia v1.1.0

Escopo: criar uma sucessora da release `v1.0.0` sem as dimensões
`operation_scope`, `operation_channel`, `event`, `impact_operational` e
`impact_system`. `theme`, `treatment` e `subject` continuam disponíveis.
A release `v1.0.0` e suas classificações históricas não são alteradas.

## Gates

1. Confirmar o head exato do PR, CI verde, `main` atual e ausência de operação
   concorrente na Taxonomia. Registrar o LOCK produtivo na Issue TAX-10.
2. Executar `node dist/infrastructure/database/taxonomy-v1-1-dry-run.js`
   contra a produção. O comando abre `BEGIN READ ONLY` e não escreve no banco.
   Exigir `action=CREATE_DRAFT`, `blockers=[]`, origem `v1.0.0` publicada,
   20 dimensões/628 conceitos na origem e 15/590 no destino planejado.
3. Após o merge e confirmação dos deploys de API, Worker e Scheduler no novo
   commit, executar `node dist/infrastructure/database/taxonomy-v1-1-create-draft.js`
   com `DATABASE_ADMIN_URL` em um executor operacional separado. O comando
   cria a `v1.1.0` em `DRAFT` numa transação serializável; repetição válida é
   idempotente. Não usar uma migration ou o pre-deploy para este passo.
4. Reexecutar o dry-run. Exigir `action=VALIDATE_EXISTING_DRAFT`, sem blockers,
   `retiredDimensionsPresent=0`, `retiredConceptsPresent=0`, 15 dimensões,
   590 conceitos e `theme`/`treatment`/`subject` presentes. Conferir também
   os totais de aliases, relações, regras, mappings e evidências copiáveis.
5. Executar `node dist/infrastructure/database/taxonomy-v1-1-publish.js
   --git-sha=<SHA_DO_COMMIT_PUBLICADO>` no mesmo executor, com
   `DATABASE_ADMIN_URL`. O comando calcula o SHA-256 do manifesto versionado
   e publica explicitamente a release numa transação serializável.
   A identidade fixa de auditoria do comando é
   `system:taxonomy-v1.1-publisher`, incluída na lista fechada do banco.
   O comando não recebe autor livre. O teste PG18 ONB-02 R7.3 executa este
   mesmo entrypoint em banco sintético isolado e verifica o commit da release
   e do evento, além da repetição idempotente.
6. Reexecutar o dry-run. Exigir `action=ALREADY_PUBLISHED`, última release
   publicada `v1.1.0`, `v1.0.0` ainda `PUBLISHED` e as contagens/integridade
   anteriores. Conferir a API de opções do Perfil Tributário e o matching
   `CURRENT_PUBLISHED`; registrar resultado e IDs sanitizados na Issue.

Os comandos de escrita exigem o papel curador e usam advisory lock
transacional para evitar duas operações simultâneas. A API/Worker não devem
ter permissão para publicar releases. O deploy do código não publica a v1.1.0.

## Interrupção e reversão

Se o dry-run indicar qualquer blocker ou divergência de contagem, parar antes
da próxima escrita. Se a criação do DRAFT falhar, a transação faz rollback; uma
nova execução só ocorre após diagnóstico. Se a publicação falhar, a transação
faz rollback e a release continua em DRAFT. Depois da publicação, não editar
nem apagar snapshots históricos. Eventual retirada de `v1.1.0` exige decisão
produtiva específica, novo preflight e registro de auditoria; não é passo
automático deste runbook.

Não registrar URLs de banco, tokens, dados privados ou logs integrais na Issue.
