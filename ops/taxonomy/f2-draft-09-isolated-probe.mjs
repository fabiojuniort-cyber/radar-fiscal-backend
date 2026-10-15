import {Pool} from 'pg';
const target=process.env.F2_ISOLATED_DATABASE_URL;
let url;
try {url=new URL(target??'');}catch{throw new Error('F2_ISOLATED_URL_MISSING');}
if(!/^(?:f2-restore-pg)(?:\.|$)/.test(url.hostname))
  throw new Error('F2_ISOLATED_TARGET_NOT_RESTORE_ONLY');
url.pathname='/f2_load07_restore_20261014';
const pool=new Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:12000});
try {
 const c=await pool.connect();
 try {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const metadata=await c.query(`SELECT current_database() db,current_setting('server_version_num')::int version,
    to_regclass('public.taxonomy_releases') IS NOT NULL releases,
    to_regclass('public.taxonomy_f2_import_batches') IS NOT NULL batches,
    to_regclass('public.taxonomy_f2_draft_import_ledger') IS NOT NULL ledger`);
  const dbs=await c.query("SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname");
  const report={database:'isolated-restore',databases:dbs.rows.map(r=>r.datname),version:metadata.rows[0].version,
    tables:{releases:metadata.rows[0].releases,batches:metadata.rows[0].batches,ledger:metadata.rows[0].ledger}};
  if(report.tables.releases){
    const a=await c.query(`SELECT id::text,version_major,version_minor,version_patch,status FROM public.taxonomy_releases WHERE (version_major=1 AND version_minor IN (6,7) AND version_patch=0) ORDER BY version_minor`);
    report.releases=a.rows.map(x=>({id:x.id,version:`v${x.version_major}.${x.version_minor}.${x.version_patch}`,status:x.status}));
  }
  if(report.tables.batches){
    const x=await c.query(`SELECT id::text,status,segmento_rows,produto_rows,content_sha256 FROM public.taxonomy_f2_import_batches WHERE id='f4ab4f0c-9755-4957-9b51-826aeddb4bca'::uuid`);
    report.batch=x.rows.map(r=>({id:r.id,status:r.status,sector:r.segmento_rows,product:r.produto_rows,matchingContent:r.content_sha256==='887574566219782e0f702f64bd69d9c0c3678d5d2a330c5e5cbca39a3610f140'}));
  }
  console.log('F2_ISOLATED_PROBE='+JSON.stringify(report));
  await c.query('ROLLBACK');
 }finally{c.release();}
}finally{await pool.end();}
