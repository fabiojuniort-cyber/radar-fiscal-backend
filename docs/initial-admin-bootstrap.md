# AUTH-01 — primeiro acesso administrativo

## Escopo

O schema existente já possui `OWNER`, `ADMIN`, `ANALYST` e `VIEWER` em `tenant_memberships`. `OWNER` é o maior papel **do tenant**. O bootstrap cria o tenant interno `TriBusca Internal`, um usuário ativo com credencial Argon2id e um vínculo `OWNER`. Não cria privilégio administrativo global nem endpoint público. O login permanece em `POST /auth/login`; sessões, JWT, refresh opaco, rotação/reuse e RLS existentes não mudam.

## Guardas

`db:initial-owner-preflight` informa apenas contagens agregadas de `tenants`, `app_users`, `user_credentials` e `tenant_memberships`. `db:provision-initial-owner` exige `DATABASE_ADMIN_URL` e um objeto JSON `{ "email": "...", "password": "..." }` em **stdin**; nenhum dado sensível é aceito em argumentos. Dentro de uma transação, o processo bloqueia as quatro tabelas, exige contagens zero, grava somente o hash da senha e cria o vínculo `OWNER`. Qualquer tentativa posterior falha e faz rollback. O script imprime só um status genérico; erros de Postgres não são despejados em logs.

O bootstrap é protegido por acesso administrativo ao banco e pelo estado vazio das tabelas de identidade. Não há regra HTTP de “primeiro usuário” nem senha mestre. Se houver qualquer registro, não for possível provar o estado ou o tenant interno não representar o escopo desejado, **não executar**: registrar o bloqueio e revisar a estratégia com evidência. Nunca alterar ou apagar identidades existentes para fazer o guarda passar.

## Gate de produção

1. Confirmar Issue, head exato, CI verde e revisão independente R2. Revalidar D-055, autorização do merge/deploy e o endereço definitivo do site.
2. Confirmar que aplicação e site estão em same-origin para `/auth/*`; o cookie HttpOnly `SameSite=Strict` não depende de CORS público. Fazer deploy e validar saúde dos serviços.
3. Em ambiente protegido da Railway, executar o preflight com credencial administrativa do banco. Registrar só as quatro contagens agregadas; todas devem ser zero.
4. Solicitar e conferir o e-mail do titular. Inserir e-mail e senha temporária em um prompt sem eco, encaminhando o JSON por **stdin** ao processo compilado; nunca incluir senha em argumento, variável permanente, histórico do shell, arquivo, SQL literal, Issue, PR, log ou ferramenta de CI. Não usar um script de execução que imprima o stdin.
5. Repetir o preflight: quatro contagens iguais a um. Validar login pelo site, `GET /auth/me`, role `OWNER`, refresh, logout e recusa de acesso após logout. Não divulgar token, cookie, hash, IDs ou payload privado.
6. Rotacionar a senha temporária por mecanismo de troca/reset aprovado antes de uso prolongado. Até existir esse fluxo, tratar a credencial como temporária e protegida pelo usuário.

**Estado desta entrega:** preparação de código e testes. Sem e-mail inequívoco e sem gate produtivo, nenhuma conta deve ser afirmada como criada.
