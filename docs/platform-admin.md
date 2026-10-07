# PLATFORM_ADMIN — operação e segurança

ACT-SCOPE-02 / D-070.

## Semântica

`PLATFORM_ADMIN` é um papel global, não vinculado a tenant. Ele autoriza as
superfícies administrativas globais da plataforma e representa bypass de
qualquer gate comercial de licença/plano.

`TAXONOMY_CURATOR` permanece no banco por compatibilidade histórica e para
migrações existentes, mas não autoriza sozinho a interface administrativa.

## Primeiro administrador

O primeiro administrador só pode ser criado por operação controlada:

```bash
npm run build
npm run platform:grant-admin -- --email=fabio.terasaka@agrex.com.br --dry-run
npm run platform:grant-admin -- --email=fabio.terasaka@agrex.com.br
```

O comando exige `DATABASE_ADMIN_URL`, não imprime credenciais e mascara o
e-mail na saída.

## Administradores seguintes

Um `PLATFORM_ADMIN` autenticado pode listar, conceder e revogar acesso por
e-mail pela interface/API. O runtime `radar_app` não recebe INSERT/UPDATE/DELETE
diretos em `platform_user_roles`; a mutação ocorre somente por funções
`SECURITY DEFINER` revisadas.

As operações são serializadas por advisory lock e auditadas em `audit_log`.
A revogação do último administrador ativo é recusada.

## Rollback

A migration 036 é aditiva em papel e funções, mas muda o CHECK da coluna
`role`. Rollback lógico seguro:

1. revogar todos os `PLATFORM_ADMIN` exceto se a feature ainda estiver ativa;
2. retirar o uso do papel no código;
3. remover funções/policy novas;
4. restaurar o CHECK anterior somente quando nenhuma linha
   `PLATFORM_ADMIN` permanecer.

Não remover linhas à força para satisfazer o CHECK.
