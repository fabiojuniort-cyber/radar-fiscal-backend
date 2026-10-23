# ONB-02 R8 — handoff do operador (NÃO EXECUTADO)

Estado observado em 23/10/2026 06:00 UTC: READ ONLY confirmou 3 empresas inativas
em 1 tenant; 2 ativas; 0 auditorias pendentes; health HTTP 200. Nenhuma purga feita.

## Gate antes de executar

Operação destrutiva R3. Registrar na Issue #118: revisão independente do SHA exato
do script abaixo, backup dentro da Railway + restauração testada em Postgres
temporário dentro da Railway + dry-run/rollback com resultado esperado, ou
dispensa explícita do Fábio das salvaguardas ausentes para ESTA purga R8.
A dispensa do backfill anterior não é uma dispensa desta operação.
Sem esse gate, executar somente o preflight READ ONLY; não usar o comando abaixo.

O script versionado está em ops/onb02/r8-inactive-purge.mjs.
O comando inline contém o mesmo código e usa os módulos compilados já implantados
da função 073, via company-purge.service + withTenantContext. Não precisa promover
este PR nem a migration 076. O responsável deve comparar o código do comando com
o arquivo no SHA revisado antes de liberar a execução. Não mudar source do runner.

## Cliques para Fábio, depois do gate registrado

1. Railway > efficient-imagination > production > f2-load-runner.
2. Confirme Custom Start Command inerte:
   `node -e "console.log('F2_DRAFT_RUNNER_INERT')"`.
   Pre-deploy vazio, restart NEVER, sem staged changes de outro serviço.
   Não abrir/alterar variáveis; o comando usa credenciais existentes apenas no runtime.
3. Abra Settings > Deploy > Custom Start Command e substitua pelo comando único
   abaixo. Confira que somente o runner mudou. Não selecionar backend/web/worker,
   não executar migration nem alterar a source do runner.
4. Deploy/Apply somente a alteração do runner. Não encerrar na etapa de build:
   aguarde status terminal e abra Deploy Logs do novo deployment.
5. Exija R8_PREFLIGHT com inactive=3, inactive_tenants=1, active=2 e
   backfill_pending=0. O script também exige exatamente 1 OWNER ativo, sem publicar
   sua identidade. Divergência interrompe ANTES da primeira purga.
6. A execução bloqueia/reconfere cada alvo como inativo, passa pela função 073
   via serviço e faz um commit separado por empresa. R8_COMPANY_COMMITTED deve
   progredir 1/2/3. Não repetir o comando para tentar corrigir falha parcial.
7. Exija R8_COMPLETE: purged=3, inactive=0, active_before=2, active_after=2,
   active_rows_unchanged=true; R8_HEALTH deve ser 200 em todas as verificações.
   R8_STOP/CRASHED/5xx: pare. A transação corrente falha com rollback; commits
   anteriores são definitivos. Recuperação usa o plano/backup aprovado, sem
   restauração automática que possa sobrescrever alterações concorrentes.
8. Sempre, inclusive em erro: volte Settings > Deploy > Custom Start Command
   para o comando inerte acima, salve e deploy somente o runner. Aguarde SUCCESS,
   log F2_DRAFT_RUNNER_INERT e ausência de staged changes.
   Se a UI deixar edição pendente, descarte-a; não deixar o comando destrutivo
   salvo nem pendente. Pre-deploy deve continuar vazio e restart NEVER.
9. Verifique /health HTTP 200 e logs HTTP do backend desde antes da operação.
   Contabilize todos os status 500–599, sem copiar URLs/headers/logs privados.
   Se houver 5xx novo, registre a contagem e pare, sem novas purgas.
10. Devolva na Issue somente contagens, flags, horários, status/CI e SHA do
    artefato. Nunca nomes, documentos, IDs, credenciais ou payloads.
    A consulta final é SELECT count(*) FROM companies WHERE is_active=false,
    executada pelo script no inventário final; deve resultar zero.
    Não fazer merge/deploy da Parte B.

## Comando único (somente APÓS o gate)

~~~sh
node --input-type=module -e '// ONB-02 R8 operator artifact. Default is READ ONLY; never logs identifiers.
import assert from '"'"'node:assert/strict'"'"';
import { resolve } from '"'"'node:path'"'"';
import { pathToFileURL } from '"'"'node:url'"'"';
import pg from '"'"'pg'"'"';
import { Kysely, PostgresDialect, sql } from '"'"'kysely'"'"';

const execute = process.argv.includes('"'"'--execute-inactive-purge'"'"');
assert.ok(process.argv.slice(process.argv[1]?.startsWith('"'"'--'"'"') ? 1 : 2).every(x => ['"'"'--plan'"'"','"'"'--execute-inactive-purge'"'"'].includes(x)));
assert.ok(!(execute && process.argv.includes('"'"'--plan'"'"')));
const value = process.env.F2_ADMIN_DATABASE_URL || process.env.SOURCE_PG_DUMP_URL;
const url = new URL(value);
assert.ok((url.hostname === '"'"'postgres.railway.internal'"'"' && url.port === '"'"'5432'"'"') ||
  (url.hostname === '"'"'acela.proxy.rlwy.net'"'"' && url.port === '"'"'39637'"'"'));
const pool = new pg.Pool({connectionString:value,max:2,connectionTimeoutMillis:10000});
const db = new Kysely({dialect:new PostgresDialect({pool})});
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code),{safeCode:code}); };
async function inventory(trx) {
  const rows = (await sql`SELECT id,tenant_id,is_active FROM companies ORDER BY id`.execute(trx)).rows;
  const inactive = rows.filter(r => r.is_active === false);
  check(rows.every(r => typeof r.is_active === '"'"'boolean'"'"'), '"'"'unexpected_state'"'"');
  return { inactive, active:rows.filter(r => r.is_active === true),
    tenants:new Set(inactive.map(r => r.tenant_id)) };
}
async function activeFingerprint(trx) {
  return (await sql`SELECT count(*)::int AS n,
    md5(coalesce(string_agg(md5(to_jsonb(c)::text),'"'"''"'"' ORDER BY id),'"'"''"'"')) AS fingerprint
    FROM companies c WHERE is_active IS TRUE`.execute(trx)).rows[0];
}
async function pending(trx) {
  return Number((await sql`SELECT count(*) AS n FROM audit_log
    WHERE public.audit_backfill_pending(audit_policy_version,actor_id)`.execute(trx)).rows[0].n);
}
async function health() {
  const r = await fetch('"'"'https://radar-fiscal-backend-production.up.railway.app/health'"'"',
    {signal:AbortSignal.timeout(10000)});
  console.log(JSON.stringify({event:'"'"'R8_HEALTH'"'"',status:r.status}));
  check(r.status === 200,'"'"'health_failed'"'"');
}
let committed = 0;
try {
  const preflight = await db.transaction().execute(async trx => {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.execute(trx);
    await sql`SET LOCAL statement_timeout='"'"'30s'"'"'`.execute(trx);
    const role = (await sql`SELECT rolsuper OR rolbypassrls AS allowed
      FROM pg_roles WHERE rolname=current_user`.execute(trx)).rows[0];
    check(role?.allowed === true,'"'"'incomplete_visibility'"'"');
    const inv = await inventory(trx), fingerprint = await activeFingerprint(trx), remaining = await pending(trx);
    console.log(JSON.stringify({event:'"'"'R8_PREFLIGHT'"'"',active:inv.active.length,inactive:inv.inactive.length,
      inactive_tenants:inv.tenants.size,backfill_pending:remaining,read_only:true}));
    check(inv.inactive.length === 3 && inv.tenants.size === 1,'"'"'inactive_count_or_tenant_divergence'"'"');
    check(remaining === 0,'"'"'backfill_pending'"'"');
    const tenant = inv.inactive[0].tenant_id;
    const owners = (await sql`SELECT m.user_id FROM tenant_memberships m
      JOIN app_users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
      WHERE m.tenant_id=${tenant}::uuid AND m.role='"'"'OWNER'"'"'
        AND u.status='"'"'ACTIVE'"'"' AND t.status='"'"'ACTIVE'"'"'`.execute(trx)).rows;
    check(owners.length === 1,'"'"'owner_context_not_unique'"'"');
    return {inv,fingerprint,tenant,user:owners[0].user_id};
  });
  await health();
  if (!execute) {
    console.log(JSON.stringify({event:'"'"'R8_PLAN_OK'"'"',purged:0,expected_inactive:3}));
  } else {
    // The Issue must record reviewed exact artifact and backup/restore evidence,
    // or the user'"'"'s explicit operation-specific waiver BEFORE this command.
    const {purgeCompany} = await import(pathToFileURL(resolve('"'"'dist/modules/company/company-purge.service.js'"'"')).href);
    const {withTenantContext} = await import(pathToFileURL(resolve('"'"'dist/infrastructure/database/tenant-context.js'"'"')).href);
    for (const target of preflight.inv.inactive) {
      await withTenantContext(db,preflight.user,preflight.tenant,async trx => {
        await sql`SET LOCAL statement_timeout='"'"'30s'"'"'`.execute(trx);
        await sql`SET LOCAL lock_timeout='"'"'5s'"'"'`.execute(trx);
        // Lock and recheck this target BEFORE calling the already deployed service.
        const row = await trx.selectFrom('"'"'companies'"'"').select(['"'"'id'"'"','"'"'tenant_id'"'"','"'"'is_active'"'"'])
          .where('"'"'id'"'"','"'"'='"'"',target.id).where('"'"'tenant_id'"'"','"'"'='"'"',preflight.tenant).forUpdate().executeTakeFirst();
        check(row?.is_active === false,'"'"'target_no_longer_inactive'"'"');
        const inv = await inventory(trx);
        check(inv.inactive.length === 3-committed && inv.tenants.size === 1 &&
          inv.inactive.every(r => preflight.inv.inactive.some(t => t.id === r.id && t.tenant_id === r.tenant_id)),
          '"'"'target_set_changed'"'"');
        check(JSON.stringify(await activeFingerprint(trx)) === JSON.stringify(preflight.fingerprint),'"'"'active_companies_changed'"'"');
        check(await pending(trx) === 0,'"'"'backfill_pending'"'"');
        check(await purgeCompany(trx,target.id),'"'"'purge_not_confirmed'"'"');
        check(JSON.stringify(await activeFingerprint(trx)) === JSON.stringify(preflight.fingerprint),'"'"'active_companies_changed'"'"');
        const after = await inventory(trx);
        check(after.inactive.length === 2-committed && !after.inactive.some(r => r.id === target.id),'"'"'post_transaction_count_failed'"'"');
      });
      committed++;
      console.log(JSON.stringify({event:'"'"'R8_COMPANY_COMMITTED'"'"',purged:committed,remaining:3-committed}));
      await health();
    }
    const after = await db.transaction().execute(async trx => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const inv=await inventory(trx);
      check(inv.inactive.length === 0,'"'"'inactive_remaining'"'"');
      check(JSON.stringify(await activeFingerprint(trx)) === JSON.stringify(preflight.fingerprint),'"'"'active_companies_changed'"'"');
      return inv;
    });
    console.log(JSON.stringify({event:'"'"'R8_COMPLETE'"'"',purged:committed,inactive:after.inactive.length,
      active_before:preflight.inv.active.length,active_after:after.active.length,active_rows_unchanged:true}));
  }
} catch(error) {
  // Never print PostgreSQL message/detail, URLs, SQL parameters, IDs or payload.
  console.log(JSON.stringify({event:'"'"'R8_STOP'"'"',committed,transaction_failure_rolls_back:true,
    code:error.safeCode || error.code || '"'"'unclassified_failure'"'"'}));
  process.exitCode=2;
} finally { await db.destroy(); }
' -- --execute-inactive-purge
~~~

Para repetir somente a leitura com o mesmo código, substitua exclusivamente
a flag final --execute-inactive-purge por --plan. Isso não chama purgeCompany.
A leitura não remove registros, não cria backup e não comprova restauração.
