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

const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".webp":"image/webp"};
const json=(res,status,obj)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(obj));};
const body=async req=>{let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw new Error("too_large");}return raw?JSON.parse(raw):{};};
const cookies=req=>Object.fromEntries((req.headers.cookie||"").split(";").map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf("=");return [decodeURIComponent(v.slice(0,i)),decodeURIComponent(v.slice(i+1))]}));
const sessionUser=req=>{const token=cookies(req).tribusca_proto_session;const email=token&&sessions.get(token);return email?users.get(email):null;};
const setSession=(res,email)=>{const token=crypto.randomBytes(24).toString("hex");sessions.set(token,email);res.setHeader("Set-Cookie","tribusca_proto_session="+token+"; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800");};

async function api(req,res,pathname,url){
  if(pathname==="/api/register"&&req.method==="POST"){
    const data=await body(req);
    const name=String(data.name||"").trim(),email=String(data.email||"").trim().toLowerCase(),company=String(data.company||"").trim(),password=String(data.password||"");
    if(!name||!email.includes("@")||!company||password.length<4)return json(res,400,{error:"invalid_fields"});
    users.set(email,{name,email,company,password}); setSession(res,email); return json(res,201,{user:{name,email,company}});
  }
  if(pathname==="/api/login"&&req.method==="POST"){
    const data=await body(req); const email=String(data.email||"").trim().toLowerCase(),password=String(data.password||"");
    const user=users.get(email);
    if(!user||user.password!==password)return json(res,401,{error:"invalid_credentials"});
    setSession(res,email); return json(res,200,{user:{name:user.name,email:user.email,company:user.company}});
  }
  if(pathname==="/api/logout"&&req.method==="POST"){
    const token=cookies(req).tribusca_proto_session;if(token)sessions.delete(token);
    res.setHeader("Set-Cookie","tribusca_proto_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");return json(res,200,{ok:true});
  }
  if(pathname==="/api/me"&&req.method==="GET"){
    const user=sessionUser(req);if(!user)return json(res,401,{error:"unauthorized"});
    return json(res,200,{user:{name:user.name,email:user.email,company:user.company}});
  }
  if(pathname==="/api/publications"&&req.method==="GET"){
    const user=sessionUser(req);if(!user)return json(res,401,{error:"unauthorized"});
    if(!pool)return json(res,503,{error:"database_unavailable"});
    const q=String(url.searchParams.get("q")||"").trim();
    const limit=Math.min(Math.max(Number(url.searchParams.get("limit")||30),1),100);
    const params=[]; let where="";
    if(q){
      params.push("%"+q+"%");
      where="WHERE (p.title ILIKE $1 OR COALESCE(p.act_number,'') ILIKE $1 OR COALESCE(p.agency,'') ILIKE $1 OR COALESCE(v.relevant_excerpt,'') ILIKE $1 OR COALESCE(v.content_text,'') ILIKE $1)";
    }
    params.push(limit); const li=params.length;
    const sql=`
      SELECT p.id,p.jurisdiction_level,p.uf,p.agency,p.act_type,p.act_number,p.title,p.published_on,p.effective_on,
             p.primary_official_url,v.relevant_excerpt,
             src.source_name,src.source_code
      FROM publications p
      LEFT JOIN publication_versions v ON v.publication_id=p.id AND v.is_current=TRUE
      LEFT JOIN LATERAL (
        SELECT s.name AS source_name,s.code AS source_code
        FROM publication_origins po
        JOIN sources s ON s.id=po.source_id
        WHERE po.publication_id=p.id
        ORDER BY po.first_seen_at ASC
        LIMIT 1
      ) src ON TRUE
      ${where}
      ORDER BY p.published_on DESC NULLS LAST,p.created_at DESC
      LIMIT $${li}`;
    try{const result=await pool.query(sql,params);return json(res,200,{items:result.rows});}
    catch(e){console.error("publications query failed",e);return json(res,500,{error:"query_failed"});}
  }
  return false;
}

http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,"http://localhost");const pathname=url.pathname;
    if(pathname.startsWith("/api/")){const handled=await api(req,res,pathname,url);if(handled!==false)return;}
    let target=pathname;
    if(target==="/")target="/index.html";
    const relative=target.startsWith("/")?target.slice(1):target;
    const file=path.join(process.cwd(),relative);
    fs.readFile(file,(err,data)=>{
      if(err){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});res.end("Not found");return;}
      res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"no-cache"});
      res.end(data);
    });
  }catch(e){console.error(e);json(res,500,{error:"internal_error"});}
}).listen(port,"0.0.0.0",async()=>{
  console.log("TriBusca prototype listening on",port);
  if(pool){
    try{
      const check=await pool.query("SELECT count(*)::int AS count FROM publications");
      console.log("TriBusca archive database connected. Publications:",check.rows[0].count);
    }catch(e){
      console.error("TriBusca archive database validation failed",e);
    }
  }
});
