# ONB-02-R3 — Exclusão definitiva de empresa (REVIEW/NO-PROD)

Issue: https://github.com/fabiojuniort-cyber/tribusca-control/issues/118

## Escopo
- A ação DELETE autenticada remove **fisicamente** a empresa, suas unidades e
  registros diretamente vinculados via FKs CASCADE (CNAE, perfis tributários,
  produtos, NCMs, monitoramento, matches), em transação única.
- Publicações oficiais, textos legais, taxonomia e catálogos globais continuam
  preservados e compartilhados; nenhum DELETE em publicações.
- Limpar dados cadastrais legados do onboarding daquele CNPJ no tenant, mantendo
  o aceite de privacidade/termos do usuário.
- Logs de autenticação e auditoria de segurança são registros independentes e
  exigem verificação de minimização e retenção. **Não afirmar apagamento de
  backups ou de histórico/auditoria antes de comprovar as políticas pertinentes.**
- A operação não poderá ser liberada enquanto houver dados privados da empresa
  em referências sem cobertura identificadas pelo preflight.

## Gates antes de produção — NÃO EXECUTAR SEM PROVAS
1. Confirmar autorização R3 vigente, LOCK e ausência de outra execução.
2. Revisão independente adversarial do SHA exato da migration/função, endpoint,
   permissões, RLS, FKs e tratamento de erros; validar impacto nos testes de
   reativação legados.
3. Obter via canal Railway **não-AI** o schema real e inventário read-only das
   referências: `pg_constraint` (FKs de company/establishments/monitoring);
   triggers; grants; `pg_policies`; referências em audit_log, onboarding,
   caches, tenant memberships, object storage e jobs.
4. Verificar backup e restore TESTADO em PostgreSQL temporário isolado dentro
   da Railway, dry-run sem alterações produtivas e plano de rollback do código;
   não usar rollback de schema ou restore de DB automaticamente.
5. Executar suíte PG18 isolada com duas contas, CNPJ repetido, perfil com
   produtos/CNAEs/NCMs, publicações compartilhadas, fail-closed de cross-tenant
   e idempotência. CI integral PASS no HEAD final, revisão independente PASS.
6. Backend PR aprovado e publicação controlada ANTES da UI que comunica
   exclusão permanente. Conferir migração, funções e privileges no banco real;
   smoke com dados de teste apenas se expressamente autorizado.
7. Confirmar pós-execução sem empresa/perfis/vínculos, outra conta inalterada,
   novo CNPJ começa do zero, logs sem dados pessoais.

## Esquema
- Migration 070 cria `app_purge_company(UUID)` sem apagar dados no momento de
  sua aplicação. Nenhum `GRANT DELETE ON companies` ao runtime.
- A função SECURITY DEFINER revalida user/tenant/admin, usa FOR UPDATE, impede
  vínculos de matching entre companhias e efetua DELETE da company + cascatas.
- Os grants e RLS para dados empresariais continuam restritos.
- `audit_log` do evento mantém somente ação sem CNPJ ou ID da empresa.

## STOP / rollback
Se uma FK ausente, falha RLS, privilégio inesperado, dado fora do tenant,
execução concorrente, divergência de contagens, incompatibilidade em versões do
app, backup/restore não comprovado ou revisão pendente: **HOLD**. Nenhuma
exclusão física em PR, merge, migration ou deploy por inferência. Reverter
código para versão anterior se necessário, depois de verificar compatibilidade
com schema; dados purgados exigem restauração individual autorizada.
