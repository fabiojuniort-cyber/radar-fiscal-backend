# ONB-02 R3 — B4: procedimento operacional com evidência (HOLD produção)

**Status na elaboração: B4 BLOCK (recuperabilidade ACCEPTED_RISK).** Este documento não equivale a backup,
restore, inventário real, dry-run ou aprovação. Executar somente com operador
autenticado na Railway e os gates da Issue
[tribusca-control#118](https://github.com/fabiojuniort-cyber/tribusca-control/issues/118).

**Não fazer:** merge do PR #246, deploy do backend/web, execução de migration
073 no PostgreSQL produtivo, requisição DELETE produtiva, restore in-place do
Postgres produtivo, redirecionamento de DATABASE_URL, exclusão/limpeza de bucket,
remoção de service/volume, exposição de credenciais, dumps, CNPJs, nomes ou
identificadores de clientes nas Issues/PRs.

## Contexto, não prova

Railway project `d7291d78-020d-42d5-8cd9-c387a156a580`, environment
`production`, banco-fonte `Postgres`. Em 17/10/2026 o backend estava em
`6b461ce05372c3574c43ffecf86a3d51f89e7f88` (deployment
`b0947195-0fa1-4a62-93d4-457f98c69649`). **Revalidar antes de agir**:
deployments e fontes podem mudar. O bucket Postgres-PITR foi encontrado por
inventário, mas sua integridade/janela de restore NÃO foram verificadas.

O conector ChatGPT Railway permite ler metadados, NÃO possui ação de executar
SQL, invocar CLI remoto, criar backup PITR ou efetuar restore PITR. A prova B4
exige um terminal Railway CLI autenticado e permissão operacional adequada.
O agente de IA da Railway é proibido nesta frente.

## Exceção de recuperação expressamente aceita pelo responsável (17/10/2026)

A solicitação do responsável foi **NÃO criar backup novo e NÃO realizar
ensaio de restauração**. Um snapshot de volume datado 17/10/2026 02:44,
aproximadamente 9,34 GB, foi observado em tela, mas a integridade e a
recuperabilidade NÃO foram provadas. Classificação **ACCEPTED_RISK**, jamais
PASS técnico. Histórico PITR sem janela recente confirmada.

Os passos originais de backup e PITR/restore abaixo ficam documentados
APENAS como alternativas técnicas, **NÃO EXECUTAR na ONB-02 atual**,
salvo mudança posterior expressa do responsável. O aceite dessa exceção
não dispensa inventário read-only do banco real, conciliação de referências
sem FK/JSONB, preservação do Acervo e de terceiros, testes adversariais,
revisão independente e autorização R3/LOCK separada.

Os instrumentos de comparação devem ser usados em instância sintética
de schema equivalente, sem acessar ou alterar dados reais em produção.
O inventário produtivo permitido é exclusivamente SELECT/read-only.

## 0. Gates de autorização da coleta

O operador deve registrar:
- Identificação do responsável e aprovação para levantamento **read-only**
  do banco produtivo; nenhum dado identificador em issue pública.
- LOCK da frente, ausência de operações simultâneas destrutivas e fontes/UF
  de outros trabalhos preservadas.
- Tratamento do dump/clone como **dados reais sensíveis**; restringir acesso,
  manter rede privada e sem domínio/TCP público; definir expiração e descarte
  seguro do clone ao fim após aprovação específica.
- Separar *permissão para criar backup/clone* da eventual autorização posterior
  para **purga produtiva**, que NÃO existe nesta fase.

## 1. Inventário somente leitura do PostgreSQL real

A partir do checkout do PR #246 **no SHA exato sob revisão**, no terminal de
operador com Railway CLI recente e cliente `psql` instalado:

```bash
railway login
railway link
railway connect Postgres --environment production --ssh
```

No prompt **psql** aberto, verificar que o alvo corresponde à fonte Postgres
de produção autorizada e executar apenas:

```sql
\set ON_ERROR_STOP on
\i ops/onb02/preflight-readonly.sql
```

O arquivo executa uma transação `REPEATABLE READ READ ONLY` e termina em
`ROLLBACK`. Conferir: grafo recursivo de FKs e colunas sem FK; owner de funções
SECURITY DEFINER; permissões efetivas runtime/worker; RLS/policies; triggers;
referências cross-company; auditoria e onboarding legados; tabelas/JSONB que
podem conter campos da empresa. Nenhum DDL, GRANT ou DELETE.

**STOP:** conexão ao ambiente errado, erro SQL, role privilegiada inesperada,
diferença schema x PR, match cruzado ou referência não inventariada.
Guardar somente relatório sanitizado de contagens/estruturas, hash SHA-256 do
arquivo gerador, UTC, versão/schema/host *não secreto* e assinatura do operador.
IDs, registros brutos e credenciais ficam em área privada.

## 2. Verificação do PITR e backup ONB-02 identificado

Usar comandos documentados em:
- https://docs.railway.com/cli/postgres
- https://docs.railway.com/volumes/point-in-time-recovery

Exemplos explícitos de leitura e solicitação de backup (backup modifica o
acervo de backup mas não os registros das empresas; fazer apenas com aprovação
do gate 0):

```bash
railway postgres pitr status --project d7291d78-020d-42d5-8cd9-c387a156a580 --environment production --service Postgres --json
railway postgres pitr backup list --project d7291d78-020d-42d5-8cd9-c387a156a580 --environment production --service Postgres --json
railway postgres pitr backup create --project d7291d78-020d-42d5-8cd9-c387a156a580 --environment production --service Postgres --name onb02-r3-preflight
```

Comprovar cobertura de restore (base backup + WAL), integridade, ID, data/hora
UTC, tamanho e resultado do job; guardar ID e evidências privadas. **Um backup
criado não é backup restaurado.** Caso PITR não tenha cobertura, STOP; não
habilitar PITR nem redeployar o Postgres como parte deste roteiro.

## 3. Restore em serviço NOVO e ISOLADO — jamais in-place

Após aprovação para criar *clone isolado*, selecionar timestamp coberto pelo
status PITR e registrar identificador do serviço-fonte, URL do projeto e a
hora UTC aprovada. Comandos exemplificativos:

```bash
railway postgres pitr restore --project d7291d78-020d-42d5-8cd9-c387a156a580 --environment production --service Postgres --at <TIMESTAMP_UTC_APROVADO> --new-service-name onb02-r3-restore
```

**Atenção:** esse comando cria e implanta um **novo serviço de banco**, com
custos e cópia de dados reais; não é um deploy do backend produtivo. Não usar
sem aprovação expressa para o clone. A origem continua intocada, conforme
documentação Railway. Não usar `backup restore` porque pode restaurar
**in-place e sobrescrever a origem**.

Validar `SUCCESS` do serviço restaurado e readback consistente da
data/hora e das contagens. Desligar acesso externo no clone, limitar atores
autorizados e impedir que backend/scheduler/worker produtivos se conectem.
Não presumir que um clone existente de outra frente seja íntegro/atual.

## 4. Dry-run exclusivamente no clone (perímetro e exclusão)

Conectar explicitamente a `onb02-r3-restore`, verificar service ID/host e
comparar com a origem **antes de qualquer alteração**. Executar o mesmo
`preflight-readonly.sql` no clone e cotejar inventário com a fonte.

**Somente no clone**, e após confirmação documentada do operador:

1. Aplicar migration 073 do SHA aprovado no clone (NUNCA no Postgres-fonte).
   Conferir owner/grants e presença de `app_purge_company(uuid)`; sem
   `GRANT DELETE` genérico ao runtime.
2. Selecionar um cadastro de **teste ou autorizado para simulação** por UUID,
   com empresas/estabelecimentos, perfis antigos, produtos/NCM, matches,
   registros globais e outro cliente. Não publicar UUID/CNPJ.
3. Rodar `company-manifest-readonly.sql` contra o clone e guardar contagens
   e fingerprints ANTES; levantar também os dados de auditoria/JSONB sem FK.
4. Provar falhas de autorização (outro tenant, analyst/sem contexto),
   concorrência, mismatch nos dois sentidos, e transação abortada antes da
   exclusão real; usar os testes PG18 já aprovados como referência, mas não
   como substituto ao clone.
5. Com autenticação de usuário OWNER **do clone** e contexto SQL restrito
   `app.user_id/app.tenant_id` em transação, invocar `app_purge_company`
   somente na cópia. Primeiro testar `BEGIN` ... `ROLLBACK`; depois
   `BEGIN` ... `COMMIT` no clone APENAS com aprovação específica.
6. Conferir zero linhas exclusivas em todos os relacionamentos da empresa
   excluída; verificar outra empresa do mesmo tenant, outro tenant e os
   fingerprints de `publications`, versões, CNAEs, catálogos, origens e
   demais globais; checar `audit_log`/dados legados e material fora do banco.
7. Recriar o CNPJ no clone via **fluxo da aplicação de teste**, não apenas
   INSERT ad hoc. Provar novos IDs e perfil tributário vazio.
8. Ensaiar recuperação seletiva da empresa a partir do backup/clone e plano
   de rollback de código. **Rollback de deploy não desfaz DELETE committed.**

Guardar relatório assinado PASS/BLOCK por etapa, SHA do código/schema,
timestamps UTC, origem e clone, resumo de hashes/contagens. Sem
prova completa de todos os vínculos ou retenção/auditoria: **BLOCK**.

## 5. Gate final sem inferência

Novo revisor independente deve confrontar HEAD do PR, CI, inventário real,
backup/restore, dry-run e provas de integridade. Só um parecer PASS, com
autorização humana R3 separada e LOCK vigente, permite discutir merge,
migração e deploy produtivo. Este roteiro **NÃO é autorização**.

### Evidências a registrar na Issue #118 (somente sanitizadas)

| Evidência | Critério de aceite | Status inicial |
| --- | --- | --- |
| HEAD e CI | 3/3 workflows SUCCESS no mesmo HEAD | PASS em a04c7a75 |
| Banco-fonte | Read-only SQL, grafo real + papéis/RLS/triggers | NOT_PROVEN |
| Backup | ID, UTC, cobertura PITR, integridade, hash | NOT_PROVEN |
| Restore | Serviço clone isolado, leitura/consistência | NOT_PROVEN |
| Dry-run | Dados A removidos; B e globais iguais | NOT_PROVEN |
| Recadastro | IDs novos e perfis vazios no clone | NOT_PROVEN |
| Recovery | Teste seletivo e rollback de código | NOT_PROVEN |
| Revisão | Revisor independente PASS no HEAD | BLOCK |
| Produção | R3/LOCK e rollout seguro | PROIBIDO |

