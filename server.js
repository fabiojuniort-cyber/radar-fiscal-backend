const http=require("http");
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const {Pool}=require("pg");

const port=3000;
const pool=process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,ssl:false}) : null;
const users=new Map();
const sessions=new Map();

users.set("demo@tribusca.com.br",{name:"Usuário Demo",email:"demo@tribusca.com.br",company:"Empresa Demonstrativa S.A.",password:"demo123"});

const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".webp":"image/webp",".png":"image/png"};
const json=(res,status,obj)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(obj));};
const body=async req=>{let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw new Error("too_large");}return raw?JSON.parse(raw):{};};
const cookies=req=>Object.fromEntries((req.headers.cookie||"").split(";").map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf("=");return [decodeURIComponent(v.slice(0,i)),decodeURIComponent(v.slice(i+1))]}));
const sessionUser=req=>{const token=cookies(req).tribusca_proto_session;const email=token&&sessions.get(token);return email?users.get(email):null;};
const setSession=(res,email)=>{const token=crypto.randomBytes(24).toString("hex");sessions.set(token,email);res.setHeader("Set-Cookie","tribusca_proto_session="+token+"; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800");};
const brTodaySql="(now() AT TIME ZONE 'America/Sao_Paulo')::date";

function healthLabel(status,lastAttempt){
  if(!lastAttempt)return "NOT_CONSULTED";
  if(status==="SUCCESS"||status==="SUCCESS_NO_RESULTS")return "OPERATIONAL";
  if(status==="PARTIAL_SUCCESS"||status==="RUNNING")return "UNSTABLE";
  if(["SOURCE_UNAVAILABLE","FETCH_FAILED","PROCESSING_FAILED"].includes(status))return "UNAVAILABLE";
  return "NOT_CONSULTED";
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

async function api(req,res,pathname,url){
  if(pathname==="/api/register"&&req.method==="POST"){
    const data=await body(req);
    const name=String(data.name||"").trim(),email=String(data.email||"").trim().toLowerCase(),company=String(data.company||"").trim(),password=String(data.password||"");
    if(!name||!email.includes("@")||!company||password.length<4)return json(res,400,{error:"invalid_fields"});
    users.set(email,{name,email,company,password});setSession(res,email);return json(res,201,{user:{name,email,company}});
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
    return json(res,200,{user:{name:user.name,email:user.email,company:user.company,trialDaysRemaining:7}});
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
        SELECT s.id,s.code,s.name,s.jurisdiction_level,s.uf,s.is_active,
               v.last_attempt_at,v.last_success_at,v.last_response_time_ms,v.last_run_status
        FROM sources s LEFT JOIN v_source_monitoring v ON v.source_id=s.id
        WHERE s.is_active=TRUE
        ORDER BY CASE s.jurisdiction_level WHEN 'FEDERAL' THEN 0 ELSE 1 END,s.name
      `);
      const sources=sourceRows.rows.map(r=>({...r,health:healthLabel(r.last_run_status,r.last_attempt_at)}));
      const summary=sources.reduce((a,s)=>{a[s.health]=(a[s.health]||0)+1;return a;},{});
      return json(res,200,{metrics:metrics.rows[0],latest:latest.rows,sourcesSummary:summary,sources:sources.slice(0,8)});
    }catch(e){console.error("dashboard failed",e);return json(res,500,{error:"dashboard_failed"});}
  }
  if(pathname==="/api/sources"&&req.method==="GET"){
    if(!requireUser(req,res)||!(await requireDb(res)))return;
    try{
      const result=await pool.query(`
        SELECT s.id,s.code,s.name,s.jurisdiction_level,s.uf,s.agency,s.base_url,s.schedule_cron,s.schedule_timezone,s.is_active,
               v.last_attempt_at,v.last_success_at,v.last_response_time_ms,v.last_run_status,
               (SELECT count(*)::int FROM collection_runs cr WHERE cr.source_id=s.id AND cr.created_at>=now()-interval '24 hours') AS runs_24h,
               (SELECT count(*)::int FROM collection_attempts ca JOIN collection_runs cr ON cr.id=ca.collection_run_id WHERE cr.source_id=s.id AND ca.started_at>=now()-interval '24 hours') AS attempts_24h,
               (SELECT count(DISTINCT po.publication_id)::int FROM publication_origins po WHERE po.source_id=s.id) AS publications_total,
               (SELECT count(DISTINCT po.publication_id)::int FROM publication_origins po JOIN publications p ON p.id=po.publication_id WHERE po.source_id=s.id AND (p.first_collected_at AT TIME ZONE 'America/Sao_Paulo')::date=${brTodaySql}) AS publications_today
        FROM sources s LEFT JOIN v_source_monitoring v ON v.source_id=s.id
        ORDER BY CASE s.jurisdiction_level WHEN 'FEDERAL' THEN 0 ELSE 1 END,s.uf NULLS FIRST,s.name
      `);
      return json(res,200,{items:result.rows.map(r=>({...r,health:healthLabel(r.last_run_status,r.last_attempt_at)}))});
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
    if(!requireUser(req,res)||!(await requireDb(res)))return;
    const data=await body(req);
    const publicationVersionId=String(data.publicationVersionId||"").trim();
    const sourceText=normalizeLegalText(data.sourceText||"");
    if(!/^[0-9a-f-]{36}$/i.test(publicationVersionId)||sourceText.length<3||sourceText.length>5000){
      return json(res,400,{error:"invalid_segment"});
    }
    try{
      const version=await pool.query(
        "SELECT id,content_text,relevant_excerpt FROM publication_versions WHERE id=$1",
        [publicationVersionId]
      );
      if(!version.rowCount)return json(res,404,{error:"version_not_found"});
      const official=normalizeLegalText(version.rows[0].content_text||version.rows[0].relevant_excerpt||"");
      if(!official||!official.includes(sourceText)){
        return json(res,400,{error:"segment_not_in_official_text"});
      }
      const segmentHash=crypto.createHash("sha256").update(sourceText,"utf8").digest("hex");
      const cached=await pool.query(
        "SELECT translation_text,engine_version,model,generated_at FROM norma_clara_translations WHERE publication_version_id=$1 AND segment_hash=$2 AND engine_version=$3",
        [publicationVersionId,segmentHash,NORMA_CLARA_ENGINE_VERSION]
      );
      if(cached.rowCount){
        return json(res,200,{translation:cached.rows[0].translation_text,engineVersion:cached.rows[0].engine_version,model:cached.rows[0].model,cached:true,generatedAt:cached.rows[0].generated_at});
      }
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[publicationVersionId+":"+segmentHash+":"+NORMA_CLARA_ENGINE_VERSION]);
        const second=await client.query(
          "SELECT translation_text,engine_version,model,generated_at FROM norma_clara_translations WHERE publication_version_id=$1 AND segment_hash=$2 AND engine_version=$3",
          [publicationVersionId,segmentHash,NORMA_CLARA_ENGINE_VERSION]
        );
        if(second.rowCount){
          await client.query("COMMIT");
          return json(res,200,{translation:second.rows[0].translation_text,engineVersion:second.rows[0].engine_version,model:second.rows[0].model,cached:true,generatedAt:second.rows[0].generated_at});
        }
        const translation=await generateNormaClara(sourceText);
        await client.query(
          "DELETE FROM norma_clara_translations WHERE publication_version_id=$1 AND segment_hash=$2 AND engine_version<>$3",
          [publicationVersionId,segmentHash,NORMA_CLARA_ENGINE_VERSION]
        );
        const inserted=await client.query(
          "INSERT INTO norma_clara_translations(publication_version_id,segment_hash,engine_version,model,translation_text) VALUES($1,$2,$3,$4,$5) RETURNING generated_at",
          [publicationVersionId,segmentHash,NORMA_CLARA_ENGINE_VERSION,NORMA_CLARA_MODEL,translation]
        );
        await client.query("COMMIT");
        return json(res,200,{translation,engineVersion:NORMA_CLARA_ENGINE_VERSION,model:NORMA_CLARA_MODEL,cached:false,generatedAt:inserted.rows[0].generated_at});
      }catch(e){
        await client.query("ROLLBACK");throw e;
      }finally{client.release();}
    }catch(e){
      console.error("norma clara failed",e);
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
    if(!requireUser(req,res)||!(await requireDb(res)))return;
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
      return json(res,200,{publication:pub.rows[0],origins:origins.rows,files:files.rows});
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