const http=require("http");
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const {Pool}=require("pg");

const port=3000;
const pool=process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,ssl:false}) : null;
const users=new Map();
const sessions=new Map();

users.set("demo@tribusca.com.br",{name:"Usuário Demo",email:"demo@tribusca.com.br",company:"Empresa Demonstrativa S.A.",password:"demo123",plan:"trial"});

const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".webp":"image/webp",".png":"image/png"};
const STATIC_FILES=new Set(["index.html","login.html","registrar.html","app.html","style.css","app-shell.css","app.js","auth.js","portal.js","portal-shell.js","logo.webp"]);
const json=(res,status,obj)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(obj));};
const body=async req=>{let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw new Error("too_large");}return raw?JSON.parse(raw):{};};
const cookies=req=>Object.fromEntries((req.headers.cookie||"").split(";").map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf("=");return [decodeURIComponent(v.slice(0,i)),decodeURIComponent(v.slice(i+1))]}));
const sessionUser=req=>{const token=cookies(req).tribusca_proto_session;const email=token&&sessions.get(token);return email?users.get(email):null;};
const setSession=(res,email)=>{const token=crypto.randomBytes(24).toString("hex");sessions.set(token,email);res.setHeader("Set-Cookie","tribusca_proto_session="+token+"; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800");};
const brTodaySql="(now() AT TIME ZONE 'America/Sao_Paulo')::date";

// Intervalo esperado entre execuções, a partir do campo de hora do cron (min h dom mon dow).
function cronIntervalHours(cron){
  const parts=String(cron||"").trim().split(/\s+/);
  if(parts.length<5)return 24;
  const h=parts[1];
  if(h==="*")return 1;
  const step=h.match(/^\*\/(\d+)$/);if(step)return Number(step[1]);
  const hours=h.split(",").map(Number).filter(x=>Number.isInteger(x)&&x>=0&&x<24).sort((a,b)=>a-b);
  if(hours.length<2)return 24;
  let gap=24-hours[hours.length-1]+hours[0];
  for(let i=1;i<hours.length;i++)gap=Math.max(gap,hours[i]-hours[i-1]);
  return gap;
}
// Regra de saúde (Onda 1):
// Não consultada: nenhuma tentativa registrada.
// Indisponível: há tentativas, mas nenhum sucesso (completo ou parcial) nas últimas 24h.
// Operacional: última execução finalizada com sucesso completo, dentro de 2x o intervalo esperado.
// Instável: todo o resto (sucesso parcial, falhas recentes com sucesso dentro de 24h, atraso).
function sourceHealth(r,now=Date.now()){
  if(!r.last_attempt_at)return "NOT_CONSULTED";
  const H=3600e3;
  const full=r.last_full_success_at?new Date(r.last_full_success_at).getTime():0;
  const any=Math.max(full,r.last_partial_success_at?new Date(r.last_partial_success_at).getTime():0);
  if(!any||now-any>24*H)return "UNAVAILABLE";
  const windowMs=Math.max(2*cronIntervalHours(r.schedule_cron),2)*H+15*60e3;
  if(["SUCCESS","SUCCESS_NO_RESULTS"].includes(r.last_finished_status)&&full&&now-full<=windowMs)return "OPERATIONAL";
  return "UNSTABLE";
}
const SOURCE_HEALTH_SQL=`
  (SELECT max(ca.started_at) FROM collection_attempts ca JOIN collection_runs cr ON cr.id=ca.collection_run_id WHERE cr.source_id=s.id) AS last_attempt_at,
  (SELECT max(cr.finished_at) FROM collection_runs cr WHERE cr.source_id=s.id AND cr.status IN ('SUCCESS','SUCCESS_NO_RESULTS')) AS last_full_success_at,
  (SELECT max(cr.finished_at) FROM collection_runs cr WHERE cr.source_id=s.id AND cr.status='PARTIAL_SUCCESS') AS last_partial_success_at,
  (SELECT cr.status FROM collection_runs cr WHERE cr.source_id=s.id AND cr.finished_at IS NOT NULL ORDER BY cr.finished_at DESC LIMIT 1) AS last_finished_status,
  (SELECT cr.status FROM collection_runs cr WHERE cr.source_id=s.id ORDER BY cr.scheduled_for DESC LIMIT 1) AS last_run_status,
  (SELECT ca.response_time_ms FROM collection_attempts ca JOIN collection_runs cr ON cr.id=ca.collection_run_id WHERE cr.source_id=s.id AND ca.response_time_ms IS NOT NULL ORDER BY ca.started_at DESC LIMIT 1) AS last_response_time_ms`;
function withHealth(r){
  const last=[r.last_full_success_at,r.last_partial_success_at].filter(Boolean).map(x=>new Date(x)).sort((a,b)=>b-a)[0]||null;
  return {...r,last_success_at:last,health:sourceHealth(r)};
}
function requireUser(req,res){const user=sessionUser(req);if(!user){json(res,401,{error:"unauthorized"});return null;}return user;}
async function requireDb(res){if(!pool){json(res,503,{error:"database_unavailable"});return false;}return true;}

const NORMA_CLARA_ENGINE_VERSION=process.env.NORMA_CLARA_ENGINE_VERSION||"nc-v1";
const NORMA_CLARA_MODEL=process.env.NORMA_CLARA_MODEL||"gpt-5.6-luna";

function outputText(response){
  for(const item of response.output||[]){
    if(item.type!=="message")continue;
    for(const content of item.content||[]){
      if(content.type==="output_text"&&typeof content.text==="string")return content.text;
    }
  }
  return "";
}
function normalizeLegalText(value){
  return String(value||"").replace(/\r\n/g,"\n").replace(/[ \t]+/g," ").trim();
}
async function ensureNormaClaraTable(){
  if(!pool)return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS norma_clara_translations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      publication_version_id UUID NOT NULL REFERENCES publication_versions(id) ON DELETE CASCADE,
      segment_hash CHAR(64) NOT NULL,
      engine_version TEXT NOT NULL,
      model TEXT NOT NULL,
      translation_text TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(publication_version_id,segment_hash,engine_version)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_norma_clara_lookup
    ON norma_clara_translations(publication_version_id,segment_hash,engine_version)
  `);
}
async function generateNormaClara(sourceText){
  if(!process.env.OPENAI_API_KEY){
    const error=new Error("openai_not_configured");error.code="openai_not_configured";throw error;
  }
  const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{
      "Authorization":"Bearer "+process.env.OPENAI_API_KEY,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:NORMA_CLARA_MODEL,
      store:false,
      input:[
        {
          role:"developer",
          content:"Você é a Norma Clara da TriBusca. Sua única função é traduzir dispositivos legais brasileiros para português claro e popular. Não interprete impacto tributário, não recomende conduta, não conclua obrigações para empresas, não acrescente fatos, não omita condições, exceções, sujeitos, datas ou limitações relevantes. Preserve o sentido jurídico do trecho. Use linguagem brasileira simples e direta. Se um termo técnico for indispensável, mantenha-o e explique-o brevemente. Responda somente no schema solicitado."
        },
        {
          role:"user",
          content:"Traduza exclusivamente o trecho oficial abaixo para português claro e popular:\n\n"+sourceText
        }
      ],
      text:{
        format:{
          type:"json_schema",
          name:"norma_clara_translation",
          strict:true,
          schema:{
            type:"object",
            properties:{
              plain_language:{type:"string",minLength:1}
            },
            required:["plain_language"],
            additionalProperties:false
          }
        }
      }
    })
  });
  const data=await response.json();
  if(!response.ok){
    const error=new Error("openai_request_failed");error.details=data;throw error;
  }
  const text=outputText(data);
  if(!text)throw new Error("openai_empty_response");
  const parsed=JSON.parse(text);
  if(!parsed.plain_language)throw new Error("openai_invalid_response");
  return parsed.plain_language.trim();
}

// Cobertura pública: só "Disponível" ou "Em implantação".
// Disponível = fonte ativa, com sucesso (completo ou parcial) nas últimas 48h e publicações no acervo.
// COVERAGE_VIA: fonte cuja cobertura é garantida por outra fonte primária (decisão congelada: DOU é PRIMARY do CONFAZ).
const COVERAGE_VIA={confaz:"dou"};
const FEDERAL_DISPLAY=[["dou","DOU / INLABS"],["confaz","CONFAZ"],["nfe-encat","Portal NF-e / ENCAT"],["sped","SPED"],["cgibs","CGIBS"],["rfb-normas","Receita Federal"]];
let coverageCache={at:0,data:null};
async function publicCoverage(){
  if(coverageCache.data&&Date.now()-coverageCache.at<5*60e3)return coverageCache.data;
  const r=await pool.query(`
    SELECT s.code,s.name,s.jurisdiction_level,s.uf,s.is_active,
      (SELECT max(cr.finished_at) FROM collection_runs cr WHERE cr.source_id=s.id AND cr.status IN ('SUCCESS','SUCCESS_NO_RESULTS','PARTIAL_SUCCESS')) AS last_success_at,
      EXISTS(SELECT 1 FROM publication_origins po WHERE po.source_id=s.id) AS has_publications
    FROM sources s`);
  const now=Date.now();
  const available=new Map(r.rows.map(x=>[x.code,Boolean(x.is_active&&x.has_publications&&x.last_success_at&&now-new Date(x.last_success_at).getTime()<=48*3600e3)]));
  const byCode=new Map(r.rows.map(x=>[x.code,x]));
  const status=code=>{
    if(available.get(code))return {status:"DISPONIVEL",via:null};
    const via=COVERAGE_VIA[code];
    if(via&&available.get(via))return {status:"DISPONIVEL",via:(FEDERAL_DISPLAY.find(f=>f[0]===via)||[via,via])[1]};
    return {status:"EM_IMPLANTACAO",via:null};
  };
  const federal=FEDERAL_DISPLAY.map(([code,label])=>({code,label,...status(code)}));
  const states={};
  for(const x of r.rows){if(x.jurisdiction_level==="STATE"&&x.uf&&status(x.code).status==="DISPONIVEL")states[x.uf]="DISPONIVEL";}
  coverageCache={at:Date.now(),data:{federal,states,updatedAt:new Date().toISOString()}};
  return coverageCache.data;
}

// ===== Norma Clara: segmentação jurídica no servidor =====
// Unidade: artigo, parágrafo (§/parágrafo único), ementa e preâmbulo. Incisos e alíneas ficam
// dentro do caput/parágrafo; só viram bloco próprio quando o bloco passa de SEG_MAX caracteres.
const SEG_MAX=2200;
const MARK_ART=String.raw`(?:Art\.\s*\d+[º°o]?(?:-[A-Z])?\s+[A-ZÀ-Ú]|Artigo\s+\d+[º°o]?(?:-[A-Z])?\s*[-–—.])`;
const MARK_PAR=String.raw`(?:§\s*\d+[º°o]?\s|Parágrafo\s+único)`;
const INLINE_BREAK=new RegExp(String.raw`([.;:!?"”])\s+(?=${MARK_ART}|${MARK_PAR})`,"g");
const LINE_START=new RegExp(String.raw`^(?:${MARK_ART}|${MARK_PAR})`);
const ITEM_START=/^(?:[IVXLCDM]{1,6}\s*[-–—]\s|[a-z]\)\s)/;
const PREAMBLE=/(?<=\.)\s+(?=(?:O|A)\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{4,}[\s,])/;
function splitLong(block){
  if(block.length<=SEG_MAX)return [block];
  const parts=block.split(/(?<=[:;])\s+(?=[IVXLCDM]{1,6}\s*[-–—]\s)/);
  const out=[];let cur="";
  for(const p of parts){if(cur&&(cur+" "+p).length>SEG_MAX){out.push(cur);cur=p}else cur=cur?cur+" "+p:p}
  if(cur)out.push(cur);
  return out.flatMap(b=>{
    const r=[];let rest=b;
    while(rest.length>SEG_MAX){let cut=rest.lastIndexOf(". ",SEG_MAX);if(cut<900)cut=SEG_MAX;r.push(rest.slice(0,cut+1).trim());rest=rest.slice(cut+1).trim()}
    if(rest)r.push(rest);return r;
  });
}
function segmentLabel(text,index,isPreamble){
  let m=text.match(/^Art\.\s*(\d+[º°o]?(?:-[A-Z])?)/);if(m)return "Art. "+m[1];
  m=text.match(/^Artigo\s+(\d+[º°o]?(?:-[A-Z])?)/);if(m)return "Artigo "+m[1];
  m=text.match(/^§\s*(\d+[º°o]?)/);if(m)return "§ "+m[1];
  if(/^Parágrafo\s+único/.test(text))return "Parágrafo único";
  if(isPreamble||(index===0&&/^(?:O|A)\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{4,}/.test(text)))return "Preâmbulo";
  if(index===0)return "Ementa";
  return "Trecho "+(index+1);
}
function legalSegments(raw){
  let text=String(raw||"").replace(/\r\n/g,"\n").replace(/[ \t]+/g," ").trim();
  if(!text)return [];
  text=text.replace(INLINE_BREAK,"$1\n\n");
  let blocks=text.split(/\n{2,}/).map(x=>x.trim()).filter(Boolean);
  if(blocks.length<2){
    blocks=[];let cur="";
    for(const line of text.split("\n").map(x=>x.trim()).filter(Boolean)){
      if(LINE_START.test(line)&&cur){blocks.push(cur);cur=line}else cur=cur?cur+"\n"+line:line;
    }
    if(cur)blocks.push(cur);
  }
  // incisos/alíneas soltos voltam para o bloco anterior
  const merged=[];
  for(const b of blocks){
    const prev=merged[merged.length-1];
    if(prev&&ITEM_START.test(b)&&(prev+"\n"+b).length<=SEG_MAX)merged[merged.length-1]=prev+"\n"+b;else merged.push(b);
  }
  // ementa e preâmbulo antes do primeiro artigo
  const out=[];
  merged.forEach((b,i)=>{
    if(i===0&&!LINE_START.test(b)){
      const pre=b.split(PREAMBLE);
      if(pre.length===2){out.push({text:pre[0].trim()});out.push({text:pre[1].trim(),preamble:true});return}
    }
    out.push({text:b});
  });
  return out.flatMap(o=>splitLong(o.text).map(t=>({text:t,preamble:!!o.preamble}))).slice(0,200).map((o,i)=>{
    const normalized=normalizeLegalText(o.text);
    return {index:i,label:segmentLabel(o.text,i,o.preamble),text:o.text,hash:crypto.createHash("sha256").update(normalized,"utf8").digest("hex"),normalized};
  });
}

// ===== Norma Clara: planos, cota e desbloqueios (protótipo: em memória, como usuários e sessões) =====
// Regras aprovadas: desbloquear um bloco consome 1 da cota (tradução nova ou reaproveitada);
// reabrir bloco já desbloqueado não consome; falha na geração não consome;
// IA só é chamada quando o bloco não existe no banco. A cota vem do plano.
const PLANS={trial:{label:"Avaliação",normaClaraBlocksMonth:Number(process.env.NORMA_CLARA_TRIAL_BLOCKS||30)}};
const NC_RATE_PER_MIN=Number(process.env.NORMA_CLARA_RATE_PER_MIN||10);
const NC_GLOBAL_DAILY=Number(process.env.NORMA_CLARA_GLOBAL_DAILY_GENERATIONS||300);
const ncUnlocks=new Map(),ncUsage=new Map(),ncBurst=new Map();
let ncGlobal={day:"",count:0};
const brDate=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo"}).format(new Date());
const ncPeriod=()=>brDate().slice(0,7);
function ncQuota(user){
  const plan=PLANS[user.plan]||PLANS.trial;const u=ncUsage.get(user.email);
  const used=u&&u.period===ncPeriod()?u.count:0;
  return {plan:user.plan||"trial",limit:plan.normaClaraBlocksMonth,used,remaining:Math.max(plan.normaClaraBlocksMonth-used,0),period:ncPeriod()};
}
function ncConsume(user){const p=ncPeriod();const u=ncUsage.get(user.email);if(!u||u.period!==p)ncUsage.set(user.email,{period:p,count:1});else u.count++}
const ncKey=hash=>hash+"|"+NORMA_CLARA_ENGINE_VERSION;
const ncIsUnlocked=(user,hash)=>Boolean(ncUnlocks.get(user.email)&&ncUnlocks.get(user.email).has(ncKey(hash)));
function ncUnlock(user,hash){if(!ncUnlocks.has(user.email))ncUnlocks.set(user.email,new Set());ncUnlocks.get(user.email).add(ncKey(hash))}
function ncBurstOk(user){
  const now=Date.now();const list=(ncBurst.get(user.email)||[]).filter(t=>now-t<60e3);
  if(list.length>=NC_RATE_PER_MIN){ncBurst.set(user.email,list);return false}
  list.push(now);ncBurst.set(user.email,list);return true;
}
function ncGlobalOk(){const d=brDate();if(ncGlobal.day!==d)ncGlobal={day:d,count:0};return ncGlobal.count<NC_GLOBAL_DAILY}
async function ncFindTranslation(db,hash){
  const r=await db.query("SELECT translation_text,engine_version,model,generated_at FROM norma_clara_translations WHERE segment_hash=$1 AND engine_version=$2 ORDER BY generated_at ASC LIMIT 1",[hash,NORMA_CLARA_ENGINE_VERSION]);
  return r.rows[0]||null;
}
async function ncCopyToVersion(db,versionId,hash,t){
  await db.query("INSERT INTO norma_clara_translations(publication_version_id,segment_hash,engine_version,model,translation_text,generated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (publication_version_id,segment_hash,engine_version) DO NOTHING",[versionId,hash,t.engine_version,t.model,t.translation_text,t.generated_at]);
}

async function api(req,res,pathname,url){
  if(pathname==="/api/public/coverage"&&req.method==="GET"){
    if(!pool)return json(res,503,{error:"database_unavailable"});
    try{
      const data=await publicCoverage();
      res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"public, max-age=300"});
      return res.end(JSON.stringify(data));
    }catch(e){console.error("coverage failed",e);return json(res,500,{error:"coverage_failed"});}
  }
  if(pathname==="/api/register"&&req.method==="POST"){
    const data=await body(req);
    const name=String(data.name||"").trim(),email=String(data.email||"").trim().toLowerCase(),company=String(data.company||"").trim(),password=String(data.password||"");
    if(!name||!email.includes("@")||!company||password.length<4)return json(res,400,{error:"invalid_fields"});
    users.set(email,{name,email,company,password,plan:"trial"});setSession(res,email);return json(res,201,{user:{name,email,company}});
  }
  if(pathname==="/api/login"&&req.method==="POST"){
    const data=await body(req);const email=String(data.email||"").trim().toLowerCase(),password=String(data.password||"");
    const user=users.get(email);if(!user||user.password!==password)return json(res,401,{error:"invalid_credentials"});
    setSession(res,email);return json(res,200,{user:{name:user.name,email:user.email,company:user.company}});
  }
  if(pathname==="/api/logout"&&req.method==="POST"){
    const token=cookies(req).tribusca_proto_session;if(token)sessions.delete(token);
    res.setHeader("Set-Cookie","tribusca_proto_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");return json(res,200,{ok:true});
  }
  if(pathname==="/api/me"&&req.method==="GET"){
    const user=requireUser(req,res);if(!user)return;
    return json(res,200,{user:{name:user.name,email:user.email,company:user.company,plan:user.plan||"trial",trialDaysRemaining:7},normaClara:ncQuota(user)});
  }
  if(pathname==="/api/dashboard"&&req.method==="GET"){
    if(!requireUser(req,res)||!(await requireDb(res)))return;
    try{
      const metrics=await pool.query(`
        SELECT
          (SELECT count(*)::int FROM publications) AS total_publications,
          (SELECT count(*)::int FROM publications WHERE (first_collected_at AT TIME ZONE 'America/Sao_Paulo')::date = ${brTodaySql}) AS publications_today,
          (SELECT count(*)::int FROM publication_versions WHERE version_no > 1 AND (captured_at AT TIME ZONE 'America/Sao_Paulo')::date = ${brTodaySql}) AS new_versions_today,
          (SELECT count(*)::int FROM sources WHERE is_active=TRUE) AS active_sources,
          (SELECT count(*)::int FROM collection_runs WHERE created_at >= now()-interval '24 hours') AS runs_24h,
          (SELECT count(*)::int FROM collection_runs WHERE created_at >= now()-interval '24 hours' AND status IN ('SUCCESS','SUCCESS_NO_RESULTS','PARTIAL_SUCCESS')) AS successful_runs_24h,
          (SELECT count(*)::int FROM collection_runs WHERE created_at >= now()-interval '24 hours' AND status IN ('SOURCE_UNAVAILABLE','FETCH_FAILED','PROCESSING_FAILED')) AS failed_runs_24h
      `);
      const latest=await pool.query(`
        SELECT p.id,p.title,p.act_type,p.act_number,p.agency,p.uf,p.jurisdiction_level,p.published_on,p.first_collected_at,
          COALESCE(src.source_name,p.agency,'Fonte oficial') AS source_name
        FROM publications p
        LEFT JOIN LATERAL (
          SELECT s.name AS source_name FROM publication_origins po JOIN sources s ON s.id=po.source_id
          WHERE po.publication_id=p.id ORDER BY po.first_seen_at ASC LIMIT 1
        ) src ON TRUE
        ORDER BY p.first_collected_at DESC LIMIT 8
      `);
      const sourceRows=await pool.query(`
        SELECT s.id,s.code,s.name,s.jurisdiction_level,s.uf,s.is_active,s.schedule_cron,${SOURCE_HEALTH_SQL}
        FROM sources s
        WHERE s.is_active=TRUE
        ORDER BY CASE s.jurisdiction_level WHEN 'FEDERAL' THEN 0 ELSE 1 END,s.name
      `);
      const sources=sourceRows.rows.map(withHealth);
      const summary=sources.reduce((a,s)=>{a[s.health]=(a[s.health]||0)+1;return a;},{});
      return json(res,200,{metrics:metrics.rows[0],latest:latest.rows,sourcesSummary:summary,sources:sources.slice(0,8)});
    }catch(e){console.error("dashboard failed",e);return json(res,500,{error:"dashboard_failed"});}
  }
  if(pathname==="/api/sources"&&req.method==="GET"){
    if(!requireUser(req,res)||!(await requireDb(res)))return;
    try{
      const result=await pool.query(`
        SELECT s.id,s.code,s.name,s.jurisdiction_level,s.uf,s.agency,s.base_url,s.schedule_cron,s.schedule_timezone,s.is_active,${SOURCE_HEALTH_SQL},
               (SELECT count(*)::int FROM collection_runs cr WHERE cr.source_id=s.id AND cr.created_at>=now()-interval '24 hours') AS runs_24h,
               (SELECT count(*)::int FROM collection_attempts ca JOIN collection_runs cr ON cr.id=ca.collection_run_id WHERE cr.source_id=s.id AND ca.started_at>=now()-interval '24 hours') AS attempts_24h,
               (SELECT count(DISTINCT po.publication_id)::int FROM publication_origins po WHERE po.source_id=s.id) AS publications_total,
               (SELECT count(DISTINCT po.publication_id)::int FROM publication_origins po JOIN publications p ON p.id=po.publication_id WHERE po.source_id=s.id AND (p.first_collected_at AT TIME ZONE 'America/Sao_Paulo')::date=${brTodaySql}) AS publications_today
        FROM sources s
        ORDER BY CASE s.jurisdiction_level WHEN 'FEDERAL' THEN 0 ELSE 1 END,s.uf NULLS FIRST,s.name
      `);
      return json(res,200,{items:result.rows.map(withHealth)});
    }catch(e){console.error("sources failed",e);return json(res,500,{error:"sources_failed"});}
  }

  if(pathname==="/api/publication-filter-options"&&req.method==="GET"){
    if(!requireUser(req,res)||!(await requireDb(res)))return;
    try{
      const [types,agencies,sources,ufs,range]=await Promise.all([
        pool.query("SELECT act_type AS value,count(*)::int AS count FROM publications WHERE act_type IS NOT NULL AND btrim(act_type)<>'' GROUP BY act_type ORDER BY count DESC,act_type LIMIT 150"),
        pool.query("SELECT agency AS value,count(*)::int AS count FROM publications WHERE agency IS NOT NULL AND btrim(agency)<>'' GROUP BY agency ORDER BY count DESC,agency LIMIT 250"),
        pool.query(`SELECT s.code AS value,s.name AS label,count(DISTINCT po.publication_id)::int AS count
                    FROM sources s JOIN publication_origins po ON po.source_id=s.id
                    GROUP BY s.code,s.name ORDER BY count DESC,s.name`),
        pool.query("SELECT uf AS value,count(*)::int AS count FROM publications WHERE uf IS NOT NULL AND btrim(uf)<>'' GROUP BY uf ORDER BY uf"),
        pool.query("SELECT min(published_on) AS min_date,max(published_on) AS max_date FROM publications")
      ]);
      return json(res,200,{
        actTypes:types.rows,
        agencies:agencies.rows,
        sources:sources.rows,
        ufs:ufs.rows,
        dateRange:range.rows[0]
      });
    }catch(e){console.error("publication filter options failed",e);return json(res,500,{error:"filter_options_failed"});}
  }
  if(pathname==="/api/publications"&&req.method==="GET"){
    if(!requireUser(req,res)||!(await requireDb(res)))return;
    try{
      const q=String(url.searchParams.get("q")||"").trim();
      const page=Math.max(Number(url.searchParams.get("page")||1),1);
      const pageSize=Math.min(Math.max(Number(url.searchParams.get("pageSize")||25),5),100);
      const source=String(url.searchParams.get("source")||"").trim();
      const uf=String(url.searchParams.get("uf")||"").trim().toUpperCase();
      const actType=String(url.searchParams.get("actType")||"").trim();
      const jurisdiction=String(url.searchParams.get("jurisdiction")||"").trim().toUpperCase();
      const agency=String(url.searchParams.get("agency")||"").trim();
      const dateFrom=String(url.searchParams.get("dateFrom")||"").trim();
      const dateTo=String(url.searchParams.get("dateTo")||"").trim();
      const clauses=[];const params=[];
      const p=v=>{params.push(v);return "$"+params.length;};
      if(q){
        const like=p("%"+q+"%");const ts=p(q);
        clauses.push(`(p.title ILIKE ${like} OR COALESCE(p.act_number,'') ILIKE ${like} OR COALESCE(p.agency,'') ILIKE ${like} OR (v.search_vector @@ websearch_to_tsquery('portuguese',${ts})))`);
      }
      if(source){const x=p(source);clauses.push(`EXISTS(SELECT 1 FROM publication_origins po2 JOIN sources s2 ON s2.id=po2.source_id WHERE po2.publication_id=p.id AND s2.code=${x})`);}
      if(uf){const x=p(uf);clauses.push(`p.uf=${x}`);}
      if(actType){const x=p(actType);clauses.push(`p.act_type=${x}`);}
      if(jurisdiction){const x=p(jurisdiction);clauses.push(`p.jurisdiction_level=${x}`);}
      if(agency){const x=p(agency);clauses.push(`p.agency=${x}`);}
      if(dateFrom){const x=p(dateFrom);clauses.push(`p.published_on>=${x}::date`);}
      if(dateTo){const x=p(dateTo);clauses.push(`p.published_on<=${x}::date`);}
      const where=clauses.length?"WHERE "+clauses.join(" AND "):"";
      const count=await pool.query(`SELECT count(*)::int AS total FROM publications p LEFT JOIN publication_versions v ON v.publication_id=p.id AND v.is_current=TRUE ${where}`,params);
      const listParams=params.slice();listParams.push(pageSize,(page-1)*pageSize);const lim="$"+(listParams.length-1),off="$"+listParams.length;
      const list=await pool.query(`
        SELECT p.id,p.jurisdiction_level,p.uf,p.agency,p.act_type,p.act_number,p.title,p.published_on,p.effective_on,
               p.primary_official_url,p.first_collected_at,v.relevant_excerpt,v.version_no,
               src.source_name,src.source_code
        FROM publications p
        LEFT JOIN publication_versions v ON v.publication_id=p.id AND v.is_current=TRUE
        LEFT JOIN LATERAL (
          SELECT s.name AS source_name,s.code AS source_code FROM publication_origins po JOIN sources s ON s.id=po.source_id
          WHERE po.publication_id=p.id ORDER BY po.first_seen_at ASC LIMIT 1
        ) src ON TRUE
        ${where}
        ORDER BY p.published_on DESC NULLS LAST,p.first_collected_at DESC
        LIMIT ${lim} OFFSET ${off}
      `,listParams);
      return json(res,200,{items:list.rows,total:count.rows[0].total,page,pageSize,totalPages:Math.max(Math.ceil(count.rows[0].total/pageSize),1)});
    }catch(e){console.error("publications query failed",e);return json(res,500,{error:"query_failed"});}
  }

  if(pathname==="/api/norma-clara"&&req.method==="POST"){
    const user=requireUser(req,res);if(!user)return;
    if(!(await requireDb(res)))return;
    const data=await body(req);
    const publicationVersionId=String(data.publicationVersionId||"").trim();
    const segmentHash=String(data.segmentHash||"").trim().toLowerCase();
    if(!/^[0-9a-f-]{36}$/i.test(publicationVersionId)||!/^[0-9a-f]{64}$/.test(segmentHash)){
      return json(res,400,{error:"invalid_segment"});
    }
    try{
      const version=await pool.query("SELECT id,content_text,relevant_excerpt FROM publication_versions WHERE id=$1",[publicationVersionId]);
      if(!version.rowCount)return json(res,404,{error:"version_not_found"});
      const segment=legalSegments(version.rows[0].content_text||version.rows[0].relevant_excerpt||"").find(x=>x.hash===segmentHash);
      if(!segment)return json(res,400,{error:"segment_not_in_official_text"});
      const reply=(t,extra)=>json(res,200,{translation:t.translation_text,engineVersion:t.engine_version,generatedAt:t.generated_at,quota:ncQuota(user),...extra});
      let existing=await ncFindTranslation(pool,segmentHash);
      if(existing&&ncIsUnlocked(user,segmentHash))return reply(existing,{alreadyUnlocked:true});
      if(!ncBurstOk(user))return json(res,429,{error:"norma_clara_rate_limited"});
      if(ncQuota(user).remaining<=0)return json(res,429,{error:"norma_clara_quota_exceeded",quota:ncQuota(user)});
      if(existing){
        await ncCopyToVersion(pool,publicationVersionId,segmentHash,existing);
        ncConsume(user);ncUnlock(user,segmentHash);
        return reply(existing,{reused:true});
      }
      if(!ncGlobalOk())return json(res,503,{error:"norma_clara_unavailable"});
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["norma-clara:"+segmentHash+":"+NORMA_CLARA_ENGINE_VERSION]);
        existing=await ncFindTranslation(client,segmentHash);
        if(existing){
          await ncCopyToVersion(client,publicationVersionId,segmentHash,existing);
          await client.query("COMMIT");
          ncConsume(user);ncUnlock(user,segmentHash);
          return reply(existing,{reused:true});
        }
        const translation=await generateNormaClara(segment.normalized);
        ncGlobal.count++;
        await client.query("DELETE FROM norma_clara_translations WHERE publication_version_id=$1 AND segment_hash=$2 AND engine_version<>$3",[publicationVersionId,segmentHash,NORMA_CLARA_ENGINE_VERSION]);
        const inserted=await client.query(
          "INSERT INTO norma_clara_translations(publication_version_id,segment_hash,engine_version,model,translation_text) VALUES($1,$2,$3,$4,$5) RETURNING generated_at",
          [publicationVersionId,segmentHash,NORMA_CLARA_ENGINE_VERSION,NORMA_CLARA_MODEL,translation]
        );
        await client.query("COMMIT");
        ncConsume(user);ncUnlock(user,segmentHash);
        return reply({translation_text:translation,engine_version:NORMA_CLARA_ENGINE_VERSION,generated_at:inserted.rows[0].generated_at},{generated:true});
      }catch(e){
        await client.query("ROLLBACK");throw e;
      }finally{client.release();}
    }catch(e){
      console.error("norma clara failed",e.message,e.details&&e.details.error&&e.details.error.code);
      if(e.code==="openai_not_configured")return json(res,503,{error:"openai_not_configured"});
      const openaiCode=e.details&&e.details.error&&e.details.error.code;
      if(openaiCode==="credit_balance_exhausted")return json(res,402,{error:"openai_credit_balance_exhausted"});
      if(openaiCode==="organization_spend_limit_exceeded"||openaiCode==="project_spend_limit_exceeded")return json(res,402,{error:"openai_spend_limit_exceeded"});
      if(openaiCode==="model_not_found")return json(res,502,{error:"openai_model_not_found"});
      return json(res,502,{error:"norma_clara_failed"});
    }
  }
  const detailMatch=pathname.match(/^\/api\/publications\/([0-9a-f-]{36})$/i);
  if(detailMatch&&req.method==="GET"){
    const user=requireUser(req,res);if(!user)return;
    if(!(await requireDb(res)))return;
    try{
      const id=detailMatch[1];
      const pub=await pool.query(`
        SELECT p.*,v.id AS version_id,v.version_no,v.content_hash,v.content_text,v.relevant_excerpt,v.captured_at
        FROM publications p LEFT JOIN publication_versions v ON v.publication_id=p.id AND v.is_current=TRUE
        WHERE p.id=$1
      `,[id]);
      if(!pub.rowCount)return json(res,404,{error:"not_found"});
      const origins=await pool.query(`SELECT s.name AS source_name,s.code AS source_code,po.external_id,po.official_url,po.first_seen_at,po.last_seen_at FROM publication_origins po JOIN sources s ON s.id=po.source_id WHERE po.publication_id=$1 ORDER BY po.first_seen_at`,[id]);
      const files=await pool.query(`SELECT pf.original_filename,pf.mime_type,pf.size_bytes,pf.official_url,pf.raw_sha256 FROM publication_files pf WHERE pf.publication_version_id=$1 ORDER BY pf.created_at`,[pub.rows[0].version_id]);
      const segs=legalSegments(pub.rows[0].content_text||pub.rows[0].relevant_excerpt||"");
      const hashes=segs.filter(x=>ncIsUnlocked(user,x.hash)).map(x=>x.hash);
      const tr=hashes.length?await pool.query("SELECT DISTINCT ON (segment_hash) segment_hash::text AS h,translation_text FROM norma_clara_translations WHERE segment_hash::text = ANY($1::text[]) AND engine_version=$2 ORDER BY segment_hash,generated_at",[hashes,NORMA_CLARA_ENGINE_VERSION]):{rows:[]};
      const map=new Map(tr.rows.map(r=>[r.h,r.translation_text]));
      const segments=segs.map(x=>({hash:x.hash,label:x.label,text:x.text,unlocked:map.has(x.hash),translation:map.get(x.hash)||null}));
      return json(res,200,{publication:pub.rows[0],origins:origins.rows,files:files.rows,segments,normaClara:ncQuota(user)});
    }catch(e){console.error("detail failed",e);return json(res,500,{error:"detail_failed"});}
  }
  return false;
}

http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,"http://localhost");const pathname=url.pathname;
    if(pathname.startsWith("/api/")){const handled=await api(req,res,pathname,url);if(handled!==false)return;}
    let target=pathname;if(target==="/")target="/index.html";
    const relative=target.startsWith("/")?target.slice(1):target;
    if(!STATIC_FILES.has(relative)){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});res.end("Not found");return;}
    const file=path.join(process.cwd(),relative);
    fs.readFile(file,(err,data)=>{
      if(err){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});res.end("Not found");return;}
      res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"no-cache"});res.end(data);
    });
  }catch(e){console.error(e);json(res,500,{error:"internal_error"});}
}).listen(port,"0.0.0.0",async()=>{
  console.log("TriBusca prototype listening on",port);
  if(pool){try{await ensureNormaClaraTable();const check=await pool.query("SELECT count(*)::int AS count FROM publications");console.log("TriBusca archive database connected. Publications:",check.rows[0].count);console.log("Norma Clara engine:",NORMA_CLARA_ENGINE_VERSION,"model:",NORMA_CLARA_MODEL,"OpenAI configured:",Boolean(process.env.OPENAI_API_KEY));}catch(e){console.error("TriBusca archive database validation failed",e);}}
});