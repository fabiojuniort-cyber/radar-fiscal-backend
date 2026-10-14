# F2-LOAD-01 — carga produtiva manual de staging
Status: implementação para revisão; **produção PROIBIDA sem OK explícito do Fábio**. Governança: tribusca-control #105.

## Escopo
Carga nas três tabelas public.taxonomy_f2_import_* somente. Preserva toda célula original; não promove release, não publica/ativa taxonomia, não cria associação por posição G/H, não toca publicações, empresas, matches ou regras. Sem HTTP endpoint, cron, scheduler, worker, migration de execução ou import do módulo pela aplicação. Command entrypoint somente manual.

O writer T03 conserva NODE_ENV=test, ISOLATED_POSTGRES18_ONLY e radar_fiscal_test. A rota produtiva separada reutiliza apenas o primitive lossless dentro de uma transação própria. PG18 obrigatório.

## Comando e ambiente (somente após autorização)
Runner dedicado, sem cron/predeploy, restart NEVER. Mesmo SHA revisado/CI verde. Credencial privada F2_LOAD_DATABASE_URL, privilégio mínimo: CONNECT/USAGE e SELECT/INSERT nas três tabelas staging; nenhuma permissão de UPDATE/DELETE, nem em publicações/regras. Um DBA autorizado provisiona a role fora deste comando; este pacote não concede permissões automaticamente. NODE_ENV=production, F2_IMPORT_SCOPE=PRODUCTION_STAGING_ONLY e F2_LOAD_ENABLED=true. Nunca usar credencial admin como atalho.

Dois arquivos XLSX originais privados e dump íntegro baixados para /run/f2. Criar manifest privado (NÃO commitar) com campos:
```json
{
 "sha256": "<SHA256 real do dump>",
 "startedAt": "<UTC ISO do início original do dump>",
 "restoreVerifiedAt": "<UTC ISO do restore isolado comprovado>",
 "restoreVerifiedSha256": "<mesmo SHA256 do dump restaurado>",
 "target": {
  "projectId": "d7291d78-020d-42d5-8cd9-c387a156a580",
  "host": "<host PostgreSQL produtivo exato>",
  "database": "<nome produtivo exato>"
 }
}
```
O manifesto é atestação operacional do operador autorizado, não uma prova criptográfica independente de que houve restore. O executante/revisor deve conferir evidência na #105. Código recalcula o SHA do arquivo real do dump e exige evidência/tempo compatíveis, validade 24h desde startedAt, timestamp não futuro, target e restore do mesmo hash. Revalidado antes de conectar e antes do COMMIT. Se backup expirar durante a transação, ROLLBACK.

Planejamento sem conexão DB/escrita:
```bash
npm run taxonomy:f2-production-load -- --mode=plan --segmento=/run/f2/segmento.xlsx --produto=/run/f2/produto.xlsx --backup=/run/f2/official.dump --backup-manifest=/run/f2/backup.json
```
Retorna sourceSha256, definido como SHA256 do JSON canônico das chaves segmentoSha256 e produtoSha256 (nessa ordem), com os hashes fixos aprovados. Esse valor é a confirmação das duas fontes, não um hash livre escolhido pelo usuário.

Comando produtivo explícito, **não executar neste pacote**:
```bash
npm run taxonomy:f2-production-load -- --mode=apply --segmento=/run/f2/segmento.xlsx --produto=/run/f2/produto.xlsx --backup=/run/f2/official.dump --backup-manifest=/run/f2/backup.json --confirm-source-sha256=<SOURCE_SHA256_DO_PLAN_APROVADO>
```
Sem flag ou com confirmação errada: bloqueio antes de abrir arquivos/DB. SHA real de cada XLSX fixo; parser lê cópias privadas dos bytes conferidos; 1332 CNAEs, 4225 produtos, 0 erros/448 avisos. NCM 2–8 dígitos e células completas preservadas. Credencial jamais em argumentos/logs.

## Atomicidade e evidência
Validar host/banco contra manifest e SELECT de identidade PG18; SERIALIZABLE + advisory lock comum ao writer T03; search_path fixo; leitura de contagens de staging, inserção batch/linhas, readback de todas as células/hashes, conferência do delta de contagens e nova validade do backup **antes do único COMMIT**. Qualquer erro DB/readback/gate reverte batch e todas as linhas. Segunda execução confere lote existente e readback e insere zero linhas (sem UPDATE). Conflito no mesmo hash não sobrescreve dados.
RESULT sanitizado: batchId, hashes, contagens antes/depois, inserções, 0 alterações ao catálogo ativo, readback PASS. Não logar payloads/células, DSN ou manifest privado. Falha no ACK do COMMIT pode ter resultado indeterminado: não retry automático; conferir batch/readback pelo mesmo hash antes de decidir novo run.

## Gates gerenciais antes da carga
CI integral no HEAD final, PG18 integração, revisão independente; preflight readonly de schema/roles/estado atual; backup íntegro com restore isolado testado <24h e adequado ao baseline de carga; ensaio do mesmo comando com os XLSX reais no clone, plano aprovado e OK explícito do Fábio. Carga não decorre de merge/deploy, CI ou flag isoladamente. Duplo run e readback necessários no ensaio e após a execução autorizada. Não modificar regras no painel enquanto incidente F3 aberto.

## Rollback
Antes do COMMIT, ROLLBACK automático total. Após COMMIT, dump não deve ser restaurado inteiro sobre produção (perda de transações posteriores). Restaurar baseline em PostgreSQL **isolado**:
```bash
pg_restore --dbname="$ROLLBACK_TEMP_ADMIN_URL" --exit-on-error --single-transaction /run/f2/official.dump
```
Comparar as três tabelas ao batch/operation específico. Preparar correção seletiva e transacional das linhas exclusivamente criadas pela carga, checando dependências posteriores; **escrita/exclusão de recuperação exige novo plano e OK explícito do Fábio**. Nenhum purge/DELETE/restore produtivo automático. Se dependências/concorrência, parar e reconciliar. Dump pode ser anterior a outras mudanças: serve como baseline de comparação, não como autorização para apagá-las.

Encerrar runner após execução: remover/esvaziar credenciais, F2_LOAD_ENABLED=false, start inerte, restart NEVER. Não mudar start dos três serviços centrais.
