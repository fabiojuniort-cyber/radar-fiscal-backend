/**
 * TAX13-R8-02: isolated official HTTPS collector CLI.
 * No user/fixture supplied bytes, response object, or HTTP implementation.
 * No production support until the owner authorizes deployment separately.
 */
import 'dotenv/config';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {captureOfficialConfazHttps,validateOfficialConfazUrl} from '../../modules/taxonomy/legal-scope/confaz-official-capture.js';
import {extractActBodyHtml} from '../../modules/collection/confaz.connector.js';
import {sanitizeLegalPresentationHtml} from '../../modules/collection/legal-presentation.js';

const hex64=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const arg=(key:string)=>process.argv.find(s=>s.startsWith('--'+key+'='))?.slice(key.length+3);
const version=arg('version');
const url=arg('official-url');
const confirmed=process.argv.includes('--confirm');
if(!version||!uuid.test(version)||!url)throw new Error('TAX13_R802_VERSION_AND_URL_REQUIRED');
validateOfficialConfazUrl(url);
const dbUrl=process.env.DATABASE_HTTP_COLLECTOR_URL;
if(!dbUrl||!['127.0.0.1','localhost'].includes(new URL(dbUrl).hostname)||
   new URL(dbUrl).username!=='radar_http_collector_runtime'||
   process.env.NODE_ENV!=='test'||process.env.GITHUB_ACTIONS==='true'||
   process.env.TAX13_R802_CAPTURE_ISOLATED_APPROVED!=='true')
  throw new Error('TAX13_R802_ISOLATED_DB_AND_EXPLICIT_APPROVAL_REQUIRED');
const collectorId=process.env.TAX13_R802_COLLECTOR_ID;
const keyId=process.env.TAX13_R802_CAPTURE_KEY_ID;
const keyHex=process.env.TAX13_R802_CAPTURE_KEY_HEX;
if(!collectorId||!keyId||!hex64.test(keyHex??''))
  throw new Error('TAX13_R802_INDEPENDENT_COLLECTOR_KEY_REQUIRED');
const db=new Pool({connectionString:dbUrl,max:1});
try {
 const roles=await db.query<{who:string;member:boolean;rolsuper:boolean;rolbypassrls:boolean}>(`
 SELECT current_user AS who,
 pg_has_role(current_user,'radar_http_collector','MEMBER') AS member,
 rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
 const role=roles.rows[0];
 if(!role||role.who!=='radar_http_collector_runtime'||!role.member||
    role.rolsuper||role.rolbypassrls)throw new Error('TAX13_R802_COLLECTOR_ROLE_NOT_ISOLATED');
 const fetchTarget=async()=>db.query<{target:{publicationVersionId:string;officialUrl:string;sanitizedHtml:string}|null}>(
  'SELECT public.tax13_r802_capture_target($1::uuid,$2::text) AS target',[version,url]);
 const target=(await fetchTarget()).rows[0]?.target;
 if(!target||target.publicationVersionId!==version||target.officialUrl!==url)
   throw new Error('TAX13_R802_UNREGISTERED_OR_INACTIVE_SOURCE');
 const captured=await captureOfficialConfazHttps(url,collectorId);
 const originalHtml=new TextDecoder('utf-8',{fatal:true}).decode(captured.rawBytes);
 const body=extractActBodyHtml(originalHtml);
 const sanitized=body?sanitizeLegalPresentationHtml(body):undefined;
 if(!sanitized||sanitized!==target.sanitizedHtml)
   throw new Error('TAX13_R802_LIVE_HTTP_PRESENTATION_NOT_SAME_VERSION');
 const presentationSha=createHash('sha256').update(sanitized,'utf8').digest('hex');
 const summary={
  publicationVersionId:version,requestUrl:url,finalUrl:captured.finalUrl,
  redirectChain:captured.redirectChain,rawSha256:captured.rawSha256,
  rawBytes:captured.rawBytes.length,collectorIdentity:captured.collectorIdentity,
  collectedAt:captured.collectedAt,tlsPeerCertificateSha256:captured.tlsPeerCertificateSha256
 };
 if(!confirmed) {
   console.log('TAX13_R802_LIVE_CAPTURE_DRY_RUN='+JSON.stringify(summary));
 }else{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try{
   const targetAgain=(await fetchTarget()).rows[0]?.target;
   if(!targetAgain||JSON.stringify(targetAgain)!==JSON.stringify(target))
     throw new Error('TAX13_R802_SOURCE_CHANGED_DURING_FETCH');
   const artifactId=randomUUID();
   const macInput=[
    'TRIBUSCA:TAX13:R802:HTTPS_CAPTURE:1',
    artifactId,captured.rawSha256,version,url,captured.finalUrl,
    captured.redirectChain.join('\n'),captured.remoteIpv4,
    captured.tlsPeerCertificateSha256,collectorId,
    captured.startedAt,captured.collectedAt
   ].join('\n');
   const mac=createHmac('sha256',Buffer.from(keyHex!,'hex'))
     .update(macInput,'utf8').digest('hex');
   await db.query(`
    INSERT INTO public.tax13_v2_original_http_artifacts
    (id,publication_version_id,official_url,http_status,raw_http_bytes,
     raw_sha256,sanitized_html_sha256,collected_at,collector_identity)
    VALUES($1::uuid,$2::uuid,$3,200,$4::bytea,$5,$6,$7::timestamptz,$8)`,
    [artifactId,version,url,captured.rawBytes,captured.rawSha256,
     presentationSha,captured.collectedAt,collectorId]);
   await db.query(`
    INSERT INTO public.tax13_v2_official_capture_receipts
    (artifact_id,capture_key_id,final_url,redirect_urls,remote_ipv4,
     tls_peer_cert_sha256,collector_identity,started_at,captured_at,receipt_mac)
    VALUES($1::uuid,$2,$3,$4::text[],$5::inet,$6,$7,$8::timestamptz,$9::timestamptz,$10)`,
    [artifactId,keyId,captured.finalUrl,captured.redirectChain,captured.remoteIpv4,
     captured.tlsPeerCertificateSha256,collectorId,captured.startedAt,
     captured.collectedAt,mac]);
   await db.query('COMMIT');
   console.log('TAX13_R802_CAPTURE_SAVED='+JSON.stringify({...summary,artifactId}));
  }catch(error){await db.query('ROLLBACK');throw error;}
 }
}finally{await db.end();}
