
(function(){
const view=document.getElementById("product-view");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const n=v=>new Intl.NumberFormat("pt-BR").format(Number(v||0));
const date=v=>v?new Date(v).toLocaleDateString("pt-BR"):"—";
const dt=v=>v?new Date(v).toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"}):"—";
const healthLabel=h=>({OPERATIONAL:"Operacional",UNSTABLE:"Instável",UNAVAILABLE:"Indisponível",NOT_CONSULTED:"Não consultada"})[h]||h;
const healthClass=h=>({OPERATIONAL:"ok",UNSTABLE:"warn",UNAVAILABLE:"bad",NOT_CONSULTED:"neutral"})[h]||"neutral";
let user=null,filterOptions=null,filtersOpen=false,publicationState={page:1,q:"",source:"",uf:"",jurisdiction:"",actType:"",agency:"",dateFrom:"",dateTo:"",period:"",mode:"acervo"};

// Segmentação jurídica e cota da Norma Clara vêm do servidor (/api/publications/:id).
const normaBox=t=>'<span>NORMA CLARA · LEITURA AUXILIAR</span><p>'+esc(t)+'</p><small class="norma-note">Gerada por IA. Não substitui o texto oficial.</small>';
function updateQuota(q){
  const el=document.getElementById("nc-quota");if(!el||!q)return;
  el.textContent="Norma Clara · "+n(q.used)+" de "+n(q.limit)+" blocos usados neste mês";
  el.title="Cada bloco desbloqueado usa 1 da cota do plano. Blocos já abertos por você não contam de novo.";
}
async function translateSegment(button,versionId,hash){
  const box=button.closest(".legal-segment").querySelector(".norma-inline");
  button.disabled=true;button.textContent="Preparando Norma Clara…";
  box.classList.add("open");box.innerHTML='<span>NORMA CLARA</span><p>Traduzindo para português claro e popular…</p>';
  try{
    const r=await fetch("/api/norma-clara",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({publicationVersionId:versionId,segmentHash:hash})});
    const data=await r.json();
    if(!r.ok){
      const code=data.error||"request_failed";
      console.warn("[norma-clara]",r.status,code);
      if(code==="norma_clara_quota_exceeded"){updateQuota(data.quota);throw new Error("QUOTA");}
      if(code==="norma_clara_rate_limited")throw new Error("RATE");
      throw new Error("UNAVAILABLE");
    }
    box.innerHTML=normaBox(data.translation);updateQuota(data.quota);
    button.textContent="Ocultar Norma Clara";button.dataset.open="1";
  }catch(e){
    const msg={
      QUOTA:"Você já usou todos os blocos da Norma Clara disponíveis no seu plano neste período. O texto oficial continua acessível.",
      RATE:"Muitas solicitações em sequência. Aguarde alguns segundos e tente novamente."
    }[e.message]||"A Norma Clara está temporariamente indisponível. O texto oficial acima continua acessível.";
    box.innerHTML='<span>NORMA CLARA</span><p>'+msg+'</p>';
    button.textContent=e.message==="QUOTA"?"Limite do plano atingido":"Tentar Norma Clara novamente";
  }finally{button.disabled=false}
}


const fmtBytes=b=>b==null?"—":b<1024?b+" B":b<1048576?(b/1024).toFixed(1).replace(".",",")+" KB":(b/1048576).toFixed(1).replace(".",",")+" MB";
const brDay=v=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo"}).format(new Date(v));
const greeting=()=>{const h=Number(new Intl.DateTimeFormat("pt-BR",{hour:"numeric",hourCycle:"h23",timeZone:"America/Sao_Paulo"}).format(new Date()));return h<12?"Bom dia":h<18?"Boa tarde":"Boa noite"};
const soon='<span class="soon">Em breve</span>';

async function api(url){const r=await fetch(url,{credentials:"same-origin"});if(r.status===401){location.href="/login.html";throw new Error("unauthorized")}const data=await r.json();if(!r.ok)throw new Error(data.error||"request_failed");return data}
async function boot(){
 const me=await api("/api/me");user=me.user;user.normaClara=me.normaClara;
 document.getElementById("top-company").textContent=user.company;
 document.getElementById("top-user").textContent=user.name+" · Avaliação: "+user.trialDaysRemaining+" dias";
 route();
}
function setActive(name){document.querySelectorAll(".product-nav a[data-route]").forEach(a=>{const on=a.dataset.route===name;a.classList.toggle("active",on);if(on)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current")})}
function head(kicker,title,subtitle,actions=""){return '<div class="product-page-head"><div><div class="eyebrow">'+kicker+'</div><h1>'+title+'</h1><p>'+subtitle+'</p></div>'+actions+'</div>'}
function metric(label,value,sub=""){return '<div class="metric"><span>'+label+'</span><b>'+value+'</b><small>'+sub+'</small></div>'}
function errorBox(msg){return '<div class="state-error" role="alert"><b>Não foi possível carregar.</b><p>'+esc(msg||"Tente novamente em instantes.")+'</p></div>'}

// ===== Início =====
async function renderInicio(){
 setActive("inicio");view.innerHTML=head("Visão Geral",greeting()+", "+esc((user.name||"").split(" ")[0])+".","O que aconteceu no monitoramento tributário e o que merece atenção agora.")+'<div class="page-loading">Carregando…</div>';
 let d;try{d=await api("/api/dashboard")}catch(e){view.querySelector(".page-loading").outerHTML=errorBox();return}
 const m=d.metrics;
 const backfill=m.publications_today>Math.max(3*(m.published_today||0),50);
 const html='<section class="metric-strip">'+
  metric("Acervo total",n(m.total_publications),"publicações preservadas")+
  metric("Novas no acervo hoje",n(m.publications_today),backfill?"inclui carga de períodos anteriores":"entraram hoje na base")+
  metric("Publicadas hoje",n(m.published_today),"pela data oficial de publicação")+
  metric("Novas versões hoje",n(m.new_versions_today),"alterações de texto capturadas")+
 '</section>'+
 '<section class="dashboard-grid"><div class="surface"><div class="surface-head"><div><span>Últimas capturas · atos normativos</span><h2>Entraram agora no acervo</h2></div><a href="#publicacoes">Ver novidades →</a></div><div class="recent-list">'+
  (d.latest.length?d.latest.map(p=>'<button class="recent-row" data-pub="'+p.id+'"><span>'+(p.published_on?date(p.published_on):'<i class="muted">coletada '+date(p.first_collected_at)+'</i>')+'</span><div><b>'+esc(p.title)+'</b><small>'+esc(p.source_name)+' · '+esc(p.act_type||"Publicação")+(p.uf?' · '+p.uf:'')+'</small></div><em aria-hidden="true">→</em></button>').join(""):'<div class="empty-inline">Nenhuma captura recente.</div>')+
 '</div></div><div class="surface source-mini"><div class="surface-head"><div><span>Saúde operacional</span><h2>Fontes</h2></div><a href="#monitoramento">Abrir central →</a></div><div class="health-summary"><div><b>'+n(d.sourcesSummary.OPERATIONAL||0)+'</b><span>Operacionais</span></div><div><b>'+n(d.sourcesSummary.UNSTABLE||0)+'</b><span>Instáveis</span></div><div><b>'+n(d.sourcesSummary.UNAVAILABLE||0)+'</b><span>Indisponíveis</span></div></div><div class="mini-sources">'+d.sources.map(s=>'<div><span class="health-dot '+healthClass(s.health)+'" aria-hidden="true"></span><b>'+esc(s.name)+'</b><small>'+healthLabel(s.health)+'</small></div>').join("")+'</div><div class="mini-foot">'+n(m.active_sources)+' fontes ativas · '+n(m.runs_24h)+' execuções em 24h</div></div></section>'+
 '<section class="module-section"><div class="section-title"><div><span>Portfólio TriBusca</span><h2>Atalhos</h2></div></div><div class="module-list">'+
  [["Busca Inteligente","Consulte todo o acervo","acervo",true],["Radar Tributário","Novidades dos últimos 7 dias","publicacoes",true],["Monitor Estadual","Fontes estaduais e federais","fontes",true],["Norma Clara","Português claro e popular, por dispositivo","norma-clara",true],["Perfil Tributário","Contexto da empresa para priorização","perfil",false]]
  .map((x,i)=>'<a href="#'+x[2]+'" class="module-row"><span class="module-num">0'+(i+1)+'</span><div><b>'+x[0]+(x[3]?'':' '+soon)+'</b><small>'+x[1]+'</small></div><span class="arrow" aria-hidden="true">→</span></a>').join("")+'</div></section>';
 view.querySelector(".page-loading").outerHTML=html;
 bindPublicationClicks();
}

// ===== Acervo e Publicações =====
const FILTER_KEYS=["q","source","uf","jurisdiction","actType","agency","dateFrom","dateTo","period","normative","sort"];
const snippetHtml=t=>esc(t).replace(/\[\[b\]\]/g,"<mark>").replace(/\[\[\/b\]\]/g,"</mark>");
function stateFromQuery(qs){
 const p=new URLSearchParams(qs||"");
 FILTER_KEYS.forEach(k=>publicationState[k]=p.get(k)||"");
 publicationState.page=Math.max(Number(p.get("page")||1),1);
}
function stateToQuery(){
 const p=new URLSearchParams();FILTER_KEYS.forEach(k=>{if(publicationState[k])p.set(k,publicationState[k])});
 if(publicationState.page>1)p.set("page",String(publicationState.page));
 return p.toString();
}
function syncUrl(){
 const qs=stateToQuery();const pub=new URLSearchParams(location.hash.split("?")[1]||"").get("pub");
 const p=new URLSearchParams(qs);if(pub)p.set("pub",pub);
 const h="#"+publicationState.mode+(p.toString()?"?"+p.toString():"");
 if(location.hash!==h){history.replaceState(null,"",h);lastRouteKey=routeKey()}
}
function optionList(items,current,labelKey="value"){
 return (items||[]).map(x=>'<option value="'+esc(x.value)+'" '+(String(current)===String(x.value)?"selected":"")+'>'+esc(x[labelKey]||x.value)+' ('+n(x.count)+')</option>').join("");
}
function activeFilterChips(){
 const chips=[];
 if(publicationState.q)chips.push(["q","Busca: "+publicationState.q]);
 if(publicationState.jurisdiction)chips.push(["jurisdiction",publicationState.jurisdiction==="FEDERAL"?"Federal":"Estadual"]);
 if(publicationState.source){const s=(filterOptions?.sources||[]).find(x=>x.value===publicationState.source);chips.push(["source","Fonte: "+(s?.label||publicationState.source)])}
 if(publicationState.actType)chips.push(["actType","Tipo: "+publicationState.actType]);
 if(publicationState.agency)chips.push(["agency","Órgão: "+publicationState.agency]);
 if(publicationState.uf)chips.push(["uf","UF: "+publicationState.uf]);
 if(publicationState.normative==="1")chips.push(["normative","Somente atos normativos"]);
 if(publicationState.dateFrom||publicationState.dateTo)chips.push(["period","Período: "+(publicationState.dateFrom?date(publicationState.dateFrom+"T12:00:00"):"início")+" → "+(publicationState.dateTo?date(publicationState.dateTo+"T12:00:00"):"hoje")]);
 if(!chips.length)return "";
 return '<div class="active-filters">'+chips.map(c=>'<button type="button" data-clear-filter="'+c[0]+'" aria-label="Remover filtro '+esc(c[1])+'">'+esc(c[1])+' <span aria-hidden="true">×</span></button>').join("")+'<button type="button" class="clear-all" data-clear-filter="all">Limpar todos</button></div>';
}
function publicationFilters(){
 const o=filterOptions||{actTypes:[],agencies:[],sources:[],ufs:[]};
 const sel=(v,x)=>publicationState.period===v?"selected":"";
 return '<div class="archive-filter-shell">'+
 '<form id="pub-filter" class="archive-search-row" role="search">'+
   '<div class="archive-search"><span aria-hidden="true">⌕</span><input id="pub-q" type="search" aria-label="Buscar no acervo" value="'+esc(publicationState.q)+'" placeholder="Buscar por título, número, órgão ou conteúdo…"></div>'+
   '<button id="toggle-filters" class="btn filter-toggle '+(filtersOpen?"active":"")+'" type="button" aria-expanded="'+filtersOpen+'" aria-controls="advanced-filters">Filtros <span id="filter-count"></span></button>'+
   '<button class="btn primary">Buscar</button>'+
 '</form>'+
 '<div class="archive-options"><label class="switch"><input type="checkbox" id="pub-normative" '+(publicationState.normative==="1"?"checked":"")+'><span>Somente atos normativos</span></label>'+
   '<label class="sort-select"><span>Ordenar</span><select id="pub-sort"><option value="">'+(publicationState.q?"Mais relevantes":"Mais recentes")+'</option><option value="date" '+(publicationState.sort==="date"?"selected":"")+'>Data de publicação</option></select></label></div>'+
 '<div id="advanced-filters" class="advanced-filters '+(filtersOpen?"open":"")+'">'+
   '<label><span>Esfera</span><select id="pub-j"><option value="">Todas</option><option value="FEDERAL" '+(publicationState.jurisdiction==="FEDERAL"?"selected":"")+'>Federal</option><option value="STATE" '+(publicationState.jurisdiction==="STATE"?"selected":"")+'>Estadual</option></select></label>'+
   '<label><span>Fonte oficial</span><select id="pub-source"><option value="">Todas as fontes</option>'+optionList(o.sources,publicationState.source,"label")+'</select></label>'+
   '<label><span>Tipo de ato</span><select id="pub-type"><option value="">Todos os tipos</option>'+optionList(o.actTypes,publicationState.actType)+'</select></label>'+
   '<label><span>Órgão</span><input id="pub-agency" list="agency-list" autocomplete="off" value="'+esc(publicationState.agency)+'" placeholder="Digite para buscar…"><datalist id="agency-list">'+(o.agencies||[]).map(x=>'<option value="'+esc(x.value)+'"></option>').join("")+'</datalist></label>'+
   '<label><span>UF</span><select id="pub-uf"><option value="">Todas</option>'+optionList(o.ufs,publicationState.uf)+'</select></label>'+
   '<label><span>Período</span><select id="pub-period"><option value="" '+sel("")+'>Todo o período</option><option value="today" '+sel("today")+'>Hoje</option><option value="7d" '+sel("7d")+'>Últimos 7 dias</option><option value="30d" '+sel("30d")+'>Últimos 30 dias</option><option value="90d" '+sel("90d")+'>Últimos 90 dias</option><option value="year" '+sel("year")+'>Este ano</option><option value="custom" '+sel("custom")+'>Personalizado</option></select></label>'+
   '<label class="custom-date '+(publicationState.period==="custom"?"show":"")+'"><span>De</span><input id="pub-from" type="date" value="'+esc(publicationState.dateFrom)+'"></label>'+
   '<label class="custom-date '+(publicationState.period==="custom"?"show":"")+'"><span>Até</span><input id="pub-to" type="date" value="'+esc(publicationState.dateTo)+'"></label>'+
   '<div class="filter-actions"><button id="apply-filters" class="btn primary" type="button">Aplicar filtros</button><button id="clear-filter" class="btn ghost" type="button">Limpar</button></div>'+
 '</div>'+
 '<div id="active-filter-area">'+activeFilterChips()+'</div>'+
 '</div>'
}
function isoLocal(d){return brDay(d)}
function applyPeriod(){
 const period=document.getElementById("pub-period").value;publicationState.period=period;
 if(period==="custom"){publicationState.dateFrom=document.getElementById("pub-from").value||"";publicationState.dateTo=document.getElementById("pub-to").value||"";return}
 if(!period){publicationState.dateFrom="";publicationState.dateTo="";return}
 const today=new Date(brDay(new Date())+"T12:00:00"),from=new Date(today);
 publicationState.dateTo=isoLocal(today);
 if(period==="7d")from.setDate(today.getDate()-6);
 if(period==="30d")from.setDate(today.getDate()-29);
 if(period==="90d")from.setDate(today.getDate()-89);
 if(period==="year")from.setMonth(0,1);
 publicationState.dateFrom=isoLocal(from);
}
function readFilterForm(){
 publicationState.page=1;
 publicationState.q=document.getElementById("pub-q").value.trim();
 publicationState.jurisdiction=document.getElementById("pub-j").value;
 publicationState.source=document.getElementById("pub-source").value;
 publicationState.actType=document.getElementById("pub-type").value;
 publicationState.agency=document.getElementById("pub-agency").value.trim();
 publicationState.uf=document.getElementById("pub-uf").value;
 publicationState.normative=document.getElementById("pub-normative").checked?"1":"";
 publicationState.sort=document.getElementById("pub-sort").value;
 applyPeriod();
}
function advancedCount(){return ["jurisdiction","source","actType","agency","uf"].filter(k=>publicationState[k]).length+(publicationState.dateFrom||publicationState.dateTo?1:0)}
function refreshFilterChrome(){
 const area=document.getElementById("active-filter-area");if(area)area.innerHTML=activeFilterChips();
 const count=advancedCount();
 const badge=document.getElementById("filter-count");if(badge)badge.textContent=count?"("+count+")":"";
 document.querySelectorAll("[data-clear-filter]").forEach(btn=>btn.onclick=()=>{
   const key=btn.dataset.clearFilter;
   if(key==="all")FILTER_KEYS.forEach(k=>publicationState[k]="");
   else if(key==="period"){publicationState.dateFrom="";publicationState.dateTo="";publicationState.period=""}
   else publicationState[key]="";
   publicationState.page=1;renderAcervo();
 });
}
async function ensureFilterOptions(){if(!filterOptions){try{filterOptions=await api("/api/publication-filter-options")}catch(e){filterOptions={actTypes:[],agencies:[],sources:[],ufs:[]}}}}
async function renderAcervo(){
 setActive("acervo");publicationState.mode="acervo";
 await ensureFilterOptions();
 if(advancedCount())filtersOpen=true;
 view.innerHTML=head("Acervo","Acervo Tributário","Busque em todas as publicações oficiais capturadas e preservadas pela TriBusca.")+publicationFilters()+'<div id="pub-results" class="surface publications-surface" aria-live="polite"><div class="page-loading">Consultando o acervo…</div></div>';
 const form=document.getElementById("pub-filter");
 form.onsubmit=e=>{e.preventDefault();readFilterForm();refreshFilterChrome();loadPublications()};
 document.getElementById("toggle-filters").onclick=e=>{filtersOpen=!filtersOpen;document.getElementById("advanced-filters").classList.toggle("open",filtersOpen);e.currentTarget.classList.toggle("active",filtersOpen);e.currentTarget.setAttribute("aria-expanded",String(filtersOpen))};
 document.getElementById("pub-period").onchange=e=>{document.querySelectorAll(".custom-date").forEach(x=>x.classList.toggle("show",e.target.value==="custom"))};
 document.getElementById("apply-filters").onclick=()=>{readFilterForm();refreshFilterChrome();loadPublications()};
 document.getElementById("clear-filter").onclick=()=>{FILTER_KEYS.forEach(k=>publicationState[k]="");publicationState.page=1;renderAcervo()};
 document.getElementById("pub-normative").onchange=()=>{readFilterForm();refreshFilterChrome();loadPublications()};
 document.getElementById("pub-sort").onchange=()=>{readFilterForm();loadPublications()};
 refreshFilterChrome();loadPublications();
}
async function loadPublications(){
 const el=document.getElementById("pub-results");if(!el)return;
 el.classList.add("is-loading");el.setAttribute("aria-busy","true");
 syncUrl();
 const params=new URLSearchParams({page:String(publicationState.page),pageSize:"25"});["q","source","uf","jurisdiction","actType","agency","dateFrom","dateTo","normative","sort"].forEach(k=>{if(publicationState[k])params.set(k,publicationState[k])});
 let d;try{d=await api("/api/publications?"+params.toString())}catch(e){el.classList.remove("is-loading");el.innerHTML=errorBox("A busca falhou. Tente novamente.");return}
 el.classList.remove("is-loading");el.removeAttribute("aria-busy");
 if(!d.items.length){
  el.innerHTML='<div class="empty-inline"><b>Nenhuma publicação encontrada.</b><p>'+(publicationState.q||advancedCount()?'Revise a busca ou remova algum filtro acima.':'O acervo ainda não possui publicações.')+'</p></div>';return;
 }
 el.innerHTML='<div class="results-head"><div><b>'+n(d.total)+'</b> publicação(ões)</div><span>Página '+d.page+' de '+n(d.totalPages)+'</span></div>'+
 '<div class="publication-table" role="list"><div class="publication-tr header" aria-hidden="true"><span>Data</span><span>Publicação</span><span>Fonte</span><span>Escopo</span><span></span></div>'+
 d.items.map(p=>'<button class="publication-tr" role="listitem" data-pub="'+p.id+'"><span>'+date(p.published_on)+'</span><span><b>'+esc(p.title)+'</b><small>'+esc([p.act_type,p.act_number,p.agency].filter(Boolean).join(" · "))+'</small>'+(p.snippet&&p.snippet.includes("[[b]]")?'<em class="snippet">…'+snippetHtml(p.snippet)+'…</em>':'')+'</span><span>'+esc(p.source_name||p.agency||"—")+'</span><span>'+esc(p.jurisdiction_level==="FEDERAL"?"Federal":(p.uf||"Estadual"))+'</span><span aria-hidden="true">→</span></button>').join("")+'</div>'+
 '<nav class="pagination" aria-label="Paginação"><button class="btn ghost" id="prev-page" '+(d.page<=1?"disabled":"")+'>← Anterior</button><span>'+n(d.total)+' resultados</span><button class="btn ghost" id="next-page" '+(d.page>=d.totalPages?"disabled":"")+'>Próxima →</button></nav>';
 document.getElementById("prev-page").onclick=()=>{if(publicationState.page>1){publicationState.page--;loadPublications();scrollTo(0,0)}};
 document.getElementById("next-page").onclick=()=>{if(publicationState.page<d.totalPages){publicationState.page++;loadPublications();scrollTo(0,0)}};
 bindPublicationClicks();
}
// Publicações = feed das novidades (coletadas nos últimos 7 dias), agrupado por dia.
let feedState={page:1,items:[],total:0,totalPages:1},feedNormative=true;
async function renderFeed(){
 setActive("publicacoes");publicationState.mode="publicacoes";feedState={page:1,items:[],total:0,totalPages:1};
 view.innerHTML=head("Inteligência","Publicações","Novidades capturadas nos últimos 7 dias, da mais recente para a mais antiga.",'<a class="btn ghost" href="#acervo">Buscar no acervo</a>')+'<div class="archive-options"><label class="switch"><input type="checkbox" id="feed-normative" '+(feedNormative?"checked":"")+'><span>Somente atos normativos</span></label><span class="muted small">Sem o filtro, aparecem também extratos, avisos, editais e atos de pessoal.</span></div><div id="feed" class="surface publications-surface" aria-live="polite"><div class="page-loading">Carregando novidades…</div></div>';
 document.getElementById("feed-normative").onchange=e=>{feedNormative=e.target.checked;feedState={page:1,items:[],total:0,totalPages:1};loadFeed()};
 await loadFeed();
}
async function loadFeed(){
 const el=document.getElementById("feed");if(!el)return;
 let d;try{d=await api("/api/publications?collectedDays=7&sort=collected&pageSize=50"+(feedNormative?"&normative=1":"")+"&page="+feedState.page)}catch(e){el.innerHTML=errorBox();return}
 feedState.items=feedState.items.concat(d.items);feedState.total=d.total;feedState.totalPages=d.totalPages;
 if(!feedState.items.length){el.innerHTML='<div class="empty-inline"><b>Nenhuma novidade nos últimos 7 dias.</b></div>';return}
 const today=brDay(new Date()),y=new Date();y.setDate(y.getDate()-1);const yesterday=brDay(y);
 const groups=new Map();feedState.items.forEach(p=>{const k=brDay(p.first_collected_at);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p)});
 el.innerHTML='<div class="results-head"><div><b>'+n(feedState.total)+'</b> novidade(s) em 7 dias</div><span>Por data de captura</span></div>'+
 [...groups].map(([k,list])=>'<section class="feed-day"><h2>'+(k===today?"Hoje":k===yesterday?"Ontem":date(k+"T12:00:00"))+' <small>'+n(list.length)+'</small></h2>'+
   list.map(p=>'<button class="recent-row" data-pub="'+p.id+'"><span>'+esc(p.act_type||"Publicação")+'</span><div><b>'+esc(p.title)+'</b><small>'+esc([p.source_name,p.agency,p.uf,p.published_on?"publicada em "+date(p.published_on):null].filter(Boolean).join(" · "))+'</small></div><em aria-hidden="true">→</em></button>').join("")+'</section>').join("")+
 (feedState.page<feedState.totalPages?'<div class="pagination"><button class="btn ghost" id="feed-more">Carregar mais</button><span>'+n(feedState.items.length)+' de '+n(feedState.total)+'</span></div>':'');
 const more=document.getElementById("feed-more");if(more)more.onclick=()=>{more.disabled=true;more.textContent="Carregando…";feedState.page++;loadFeed()};
 bindPublicationClicks();
}

// ===== Detalhe da publicação =====
function bindPublicationClicks(){document.querySelectorAll("[data-pub]").forEach(b=>b.onclick=()=>openPublication(b.dataset.pub,true))}
function setPubInUrl(id){
 const [path,qs]=location.hash.slice(1).split("?");const p=new URLSearchParams(qs||"");
 if(id)p.set("pub",id);else p.delete("pub");
 const h="#"+(path||"inicio")+(p.toString()?"?"+p.toString():"");
 if(location.hash!==h){if(id)history.pushState(null,"",h);else history.replaceState(null,"",h)}
 lastRouteKey=routeKey();
}
function closePublication(){document.getElementById("drawer").classList.remove("open");setPubInUrl(null)}
function factRow(label,value){return '<div><dt>'+label+'</dt><dd>'+value+'</dd></div>'}
async function openPublication(id,push){
 const drawer=document.getElementById("drawer"),content=document.getElementById("drawer-content");
 drawer.classList.add("open");drawer.dataset.pub=id;content.innerHTML='<div class="page-loading">Abrindo publicação…</div>';
 if(push)setPubInUrl(id);
 let d;try{d=await api("/api/publications/"+id)}catch(e){content.innerHTML=errorBox("A publicação não pôde ser aberta.");return}
 const p=d.publication,segments=d.segments||[],versions=d.versions||[],origins=d.origins||[],files=d.files||[];
 const scope=p.jurisdiction_level==="FEDERAL"?"Federal":("Estadual"+(p.uf?" · "+p.uf:""));
 const documentHtml=segments.length
   ?segments.map((s,i)=>'<section class="legal-segment"><div class="segment-ref">'+esc(s.label)+'</div><div class="segment-official">'+esc(s.text)+'</div>'+(s.unlocked
       ?'<button class="norma-segment-btn" data-index="'+i+'" data-open="1" aria-expanded="true">Ocultar Norma Clara</button><div class="norma-inline open">'+normaBox(s.translation)+'</div>'
       :'<button class="norma-segment-btn" data-index="'+i+'">Traduzir para português claro e popular</button><div class="norma-inline"></div>')+'</section>').join("")
   :'<div class="document-empty">O texto integral ainda não está armazenado para esta publicação. Consulte a fonte oficial.</div>';
 const filesHtml=files.length?files.map(f=>'<div class="file-row"><div><b>'+esc(f.original_filename||"Arquivo oficial")+'</b><small>'+esc(f.mime_type||"")+' · '+fmtBytes(f.size_bytes)+'</small><code title="SHA-256 do arquivo original">SHA-256 '+esc(String(f.raw_sha256||"").slice(0,16))+'…</code></div>'+(f.official_url?'<a target="_blank" rel="noopener" href="'+esc(f.official_url)+'">Baixar na origem ↗</a>':'')+'</div>').join(""):'<p class="muted">Nenhum arquivo anexado a esta versão.</p>';
 const originsHtml=origins.map((o,i)=>'<div class="file-row"><div><b>'+esc(o.source_name)+(i===0?' <span class="tag-lite">origem principal</span>':'')+'</b><small>Vista pela primeira vez em '+dt(o.first_seen_at)+' · última em '+dt(o.last_seen_at)+'</small></div><a target="_blank" rel="noopener" href="'+esc(o.official_url)+'">Abrir origem ↗</a></div>').join("");
 const versionsHtml=versions.map(v=>'<div class="file-row"><div><b>Versão '+v.version_no+(v.is_current?' <span class="tag-lite">atual</span>':'')+'</b><small>Capturada em '+dt(v.captured_at)+'</small><code>hash '+esc(String(v.content_hash).slice(0,16))+'…</code></div>'+(v.version_no>1?'<button class="btn ghost small" data-diff="'+v.version_no+'">Ver o que mudou</button>':'<span class="muted small">versão original</span>')+'</div>').join("")+'<div id="diff-area"></div>';
 content.innerHTML=
  '<div class="drawer-eyebrow">'+esc(p.act_type||"Publicação oficial")+'</div><h1 id="pub-title">'+esc(p.title)+'</h1>'+
  '<div class="detail-actions">'+(p.primary_official_url?'<a class="btn primary" target="_blank" rel="noopener" href="'+esc(p.primary_official_url)+'">Fonte oficial ↗</a>':'')+'<button class="btn ghost" id="copy-link" type="button">Copiar link</button><span class="norma-ready" id="nc-quota">Norma Clara por dispositivo</span></div>'+
  '<section class="layer layer-fact" aria-labelledby="l-fact"><div class="layer-label" id="l-fact">Fato oficial</div><dl class="fact-grid">'+
   factRow("Tipo de ato",esc(p.act_type||"—"))+factRow("Número",esc(p.act_number||"—"))+factRow("Órgão",esc(p.agency||"—"))+factRow("Esfera",esc(scope))+
   factRow("Publicação",date(p.published_on))+factRow("Vigência",p.effective_on?date(p.effective_on):"Não informada na fonte")+factRow("Capturada em",dt(p.first_collected_at))+factRow("Versão atual",esc(p.version_no||1)+(versions.length>1?" de "+versions.length:""))+
  '</dl></section>'+
  '<section class="layer layer-intel" aria-labelledby="l-intel"><div class="layer-label" id="l-intel">Inteligência TriBusca</div><p><b>Marcadores Tributários:</b> esta publicação ainda não foi classificada. A classificação usará a taxonomia controlada da TriBusca e será exibida aqui, com evidência.</p>'+citationsHtml(d.citations||[])+'</section>'+
  '<div class="detail-tabs" role="tablist"><button role="tab" aria-selected="true" data-tab="texto">Texto oficial</button><button role="tab" aria-selected="false" data-tab="origem">Arquivos e origem ('+(files.length+origins.length)+')</button><button role="tab" aria-selected="false" data-tab="versoes">Versões ('+versions.length+')</button></div>'+
  '<div class="tab-panel" data-panel="texto" role="tabpanel"><article class="legal-document">'+documentHtml+'</article></div>'+
  '<div class="tab-panel" data-panel="origem" role="tabpanel" hidden><h3 class="panel-h">Origens oficiais'+(origins.length>1?' <small>também publicado em '+(origins.length-1)+' outra(s) fonte(s)</small>':'')+'</h3>'+originsHtml+'<h3 class="panel-h">Arquivos preservados</h3>'+filesHtml+'</div>'+
  '<div class="tab-panel" data-panel="versoes" role="tabpanel" hidden>'+versionsHtml+'</div>';
 content.querySelectorAll("[data-tab]").forEach(t=>t.onclick=()=>{
  content.querySelectorAll("[data-tab]").forEach(x=>x.setAttribute("aria-selected",String(x===t)));
  content.querySelectorAll("[data-panel]").forEach(x=>x.hidden=x.dataset.panel!==t.dataset.tab);
 });
 content.querySelectorAll("[data-diff]").forEach(b=>b.onclick=()=>showDiff(p.id,Number(b.dataset.diff)));
 content.querySelectorAll(".cite-link[data-pub]").forEach(b=>b.onclick=()=>{openPublication(b.dataset.pub,true);document.querySelector(".drawer-panel").scrollTop=0});
 content.querySelectorAll(".cite-maybe").forEach(a=>a.onclick=()=>document.getElementById("drawer").classList.remove("open"));
 document.getElementById("copy-link").onclick=async e=>{const url=location.origin+location.pathname+"#acervo?pub="+p.id;try{await navigator.clipboard.writeText(url);e.target.textContent="Link copiado"}catch{e.target.textContent=url}};
 content.querySelectorAll(".norma-segment-btn").forEach(btn=>{
   btn.onclick=()=>{
     const idx=Number(btn.dataset.index),box=btn.closest(".legal-segment").querySelector(".norma-inline");
     if(btn.dataset.open==="1"){box.classList.toggle("open");const open=box.classList.contains("open");btn.textContent=open?"Ocultar Norma Clara":"Mostrar Norma Clara";btn.setAttribute("aria-expanded",String(open));return}
     translateSegment(btn,p.version_id,segments[idx].hash);
   };
 });
 updateQuota(d.normaClara);
}
function citationsHtml(list){
 if(!list.length)return '<p class="cite-empty"><b>Normas citadas:</b> nenhuma referência a outra norma foi identificada no texto.</p>';
 const found=list.filter(c=>c.status==="FOUND").length;
 const order={FOUND:0,POSSIBLE:1,NOT_CAPTURED:2};list=list.slice().sort((a,b)=>order[a.status]-order[b.status]);
 const missing=list.filter(c=>c.status==="NOT_CAPTURED").length,visible=list.filter(c=>c.status!=="NOT_CAPTURED").length;
 const row=c=>'<li><span class="cite-label">'+esc(c.label)+'</span>'+(c.status==="FOUND"
    ?'<button type="button" class="cite-link" data-pub="'+c.publication.id+'">Abrir no acervo →</button>'
    :c.status==="POSSIBLE"
      ?'<a class="cite-maybe" href="#acervo?q='+encodeURIComponent(c.label)+'">'+c.candidates.length+' possível(is) correspondência(s) →</a>'
      :'<span class="cite-missing">ainda não capturada</span>')+'</li>';
 return '<div class="citations"><p><b>Normas citadas no texto</b> <span class="muted">· '+list.length+' identificada(s) por regras no texto oficial'+(found?', '+found+' no acervo':'')+'</span></p><ul>'+list.filter(c=>c.status!=="NOT_CAPTURED").map(row).join("")+'</ul>'+
  (missing?'<details class="cite-more"'+(visible?'':' open')+'><summary>'+missing+' norma(s) citada(s) ainda não capturada(s)</summary><ul>'+list.filter(c=>c.status==="NOT_CAPTURED").map(row).join("")+'</ul></details>':'')+'</div>';
}
async function showDiff(id,to){
 const area=document.getElementById("diff-area");area.innerHTML='<div class="page-loading">Comparando versões…</div>';
 let d;try{d=await api("/api/publications/"+id+"/diff?to="+to)}catch(e){area.innerHTML=errorBox("Não foi possível comparar as versões.");return}
 const changed=d.changes.filter(c=>c.op!=="same");
 area.innerHTML='<div class="diff-head">Versão '+d.from.version_no+' → '+d.to.version_no+' · '+(changed.length?n(changed.length)+' dispositivo(s) alterado(s)':'nenhuma diferença de texto')+'</div>'+
 changed.map(c=>'<section class="diff-seg diff-'+c.op+'"><div class="segment-ref">'+esc(c.label)+' · '+({changed:"alterado",added:"incluído",removed:"removido"}[c.op])+'</div><div class="segment-official">'+
  (c.op==="changed"?c.parts.map(x=>x.op==="eq"?esc(x.text):x.op==="ins"?'<ins>'+esc(x.text)+'</ins>':'<del>'+esc(x.text)+'</del>').join(""):c.op==="added"?'<ins>'+esc(c.text)+'</ins>':'<del>'+esc(c.text)+'</del>')+'</div></section>').join("");
}

// ===== Monitoramento =====
const runStatus=s=>({SUCCESS:"Sucesso",SUCCESS_NO_RESULTS:"Sucesso, sem novidades",PARTIAL_SUCCESS:"Sucesso parcial",RUNNING:"Em execução",PENDING:"Agendada",SOURCE_UNAVAILABLE:"Fonte indisponível",FETCH_FAILED:"Falha na coleta",PROCESSING_FAILED:"Falha no processamento",CANCELLED:"Cancelada",NOT_CONSULTED:"Não consultada"})[s]||s||"—";
const dur=(a,b)=>{if(!a||!b)return "";const s=Math.round((new Date(b)-new Date(a))/1000);return s<60?s+" s":Math.floor(s/60)+" min "+(s%60)+" s"};
async function renderMonitor(){
 setActive("monitoramento");view.innerHTML=head("Monitoramento","Central de Monitoramento","Saúde operacional das fontes. Não confundir com cobertura: uma fonte saudável pode não ter novidades.")+'<div class="page-loading">Consultando execuções…</div>';
 let d;try{d=await api("/api/sources")}catch(e){view.querySelector(".page-loading").outerHTML=errorBox();return}
 const c=h=>d.items.filter(x=>x.health===h).length;
 view.querySelector(".page-loading").outerHTML='<section class="metric-strip four">'+metric("Operacionais",c("OPERATIONAL"),"sucesso completo no prazo")+metric("Instáveis",c("UNSTABLE"),"sucesso parcial ou atraso")+metric("Indisponíveis",c("UNAVAILABLE"),"sem sucesso em 24h")+metric("Não consultadas",c("NOT_CONSULTED"),"sem tentativa registrada")+'</section>'+monitorTable(d.items)+
 '<p class="legend">Uma <b>execução</b> é a coleta agendada de uma fonte; cada execução pode ter várias <b>tentativas</b>. Uma execução pode terminar com sucesso mesmo após tentativas com erro.</p>';
 view.querySelectorAll("[data-runs]").forEach(b=>b.onclick=()=>toggleRuns(b));
}
function monitorTable(items){
 return '<section class="surface source-table-wrap"><div class="source-table monitor"><div class="source-tr header" aria-hidden="true"><span>Fonte</span><span>Saúde</span><span>Última execução</span><span>Último sucesso</span><span>Tentativas 24h</span><span>Próxima</span><span>Hoje / Total</span></div>'+
 items.map(s=>{const r=s.last_run||{};return '<div class="source-block"><div class="source-tr"><span><b>'+esc(s.name)+'</b><small>'+esc(s.code)+(s.uf?' · '+s.uf:'')+'</small></span>'+
  '<span><i class="health-dot '+healthClass(s.health)+'" aria-hidden="true"></i>'+healthLabel(s.health)+'</span>'+
  '<span>'+runStatus(r.status)+'<small>'+dt(r.started_at)+(r.finished_at?' · '+dur(r.started_at,r.finished_at):'')+'</small></span>'+
  '<span>'+dt(s.last_success_at)+'</span>'+
  '<span>'+n(s.attempts_24h)+(s.failed_attempts_24h?'<small class="warn-text">'+n(s.failed_attempts_24h)+' com erro</small>':'<small>sem erros</small>')+'</span>'+
  '<span>'+(s.next_run_at?dt(s.next_run_at):(s.is_active?'Sob demanda':'Inativa'))+'</span>'+
  '<span>'+n(s.publications_today)+' / '+n(s.publications_total)+'</span></div>'+
  '<button class="runs-toggle" type="button" data-runs="'+esc(s.code)+'" aria-expanded="false">Ver últimas execuções</button><div class="runs-panel" hidden></div></div>'}).join("")+'</div></section>';
}
async function toggleRuns(btn){
 const panel=btn.nextElementSibling,open=btn.getAttribute("aria-expanded")==="true";
 btn.setAttribute("aria-expanded",String(!open));btn.textContent=open?"Ver últimas execuções":"Ocultar execuções";panel.hidden=open;
 if(open||panel.dataset.loaded)return;
 panel.innerHTML='<div class="page-loading">Carregando…</div>';
 let d;try{d=await api("/api/sources/"+encodeURIComponent(btn.dataset.runs)+"/runs")}catch(e){panel.innerHTML=errorBox();return}
 panel.dataset.loaded="1";
 panel.innerHTML=d.items.length?d.items.map(r=>'<div class="run-row"><div><b>'+runStatus(r.status)+'</b><small>'+dt(r.started_at||r.scheduled_for)+(r.finished_at?' · '+dur(r.started_at,r.finished_at):'')+' · '+(r.trigger_type==="SCHEDULED"?"agendada":r.trigger_type==="MANUAL"?"manual":"carga histórica")+'</small>'+(r.error_summary?'<small class="warn-text">'+esc(r.error_summary)+'</small>':'')+'</div><ol class="attempts">'+r.attempts.map(a=>'<li>Tentativa '+a.attempt_no+': '+runStatus(a.status)+(a.response_time_ms?' · '+n(a.response_time_ms)+' ms':'')+(a.error_code?' · '+esc(a.error_code):'')+'</li>').join("")+'</ol></div>').join(""):'<p class="muted">Nenhuma execução registrada.</p>';
}
async function renderSources(){
 setActive("fontes");view.innerHTML=head("Monitoramento","Fontes Oficiais","Fontes cadastradas, cobertura e volume capturado.")+'<div class="page-loading">Carregando fontes…</div>';
 let d;try{d=await api("/api/sources")}catch(e){view.querySelector(".page-loading").outerHTML=errorBox();return}
 view.querySelector(".page-loading").outerHTML='<section class="surface source-table-wrap"><div class="source-table"><div class="source-tr header" aria-hidden="true"><span>Fonte</span><span>Esfera</span><span>Frequência</span><span>Saúde</span><span>Hoje</span><span>Total</span></div>'+
 d.items.map(s=>'<div class="source-tr"><span><b>'+esc(s.name)+'</b><small><a href="'+esc(s.base_url)+'" target="_blank" rel="noopener">'+esc(String(s.base_url||"").replace(/^https?:\/\//,"").replace(/\/$/,""))+' ↗</a></small></span><span>'+(s.jurisdiction_level==="FEDERAL"?"Federal":"Estadual · "+esc(s.uf||""))+'</span><span>'+cronLabel(s.schedule_cron)+'</span><span><i class="health-dot '+healthClass(s.health)+'" aria-hidden="true"></i>'+healthLabel(s.health)+'</span><span>'+n(s.publications_today)+'</span><span>'+n(s.publications_total)+'</span></div>').join("")+'</div></section>';
}
function cronLabel(c){if(!c)return "Sob demanda";const p=c.split(/\s+/);if(p[1]==="*")return "De hora em hora";if(p[1].includes(","))return p[1].split(",").length+"× ao dia ("+p[1].split(",").map(h=>h+"h").join(", ")+")";return "Diária"}

// ===== Demais páginas =====
function renderMarkers(){setActive("marcadores");view.innerHTML=head("Inteligência","Marcadores Tributários","A taxonomia controlada que conectará publicações, busca e Perfil Tributário.")+'<section class="editorial-page"><div class="taxonomy-demo"><div><span>Tributo</span><b>ICMS</b><b>ISS</b><b>IBS</b><b>CBS</b></div><div><span>Operação</span><b>Venda</b><b>Transferência</b><b>Devolução</b><b>Formação de lote</b></div><div><span>Segmento</span><b>Agronegócio</b><b>Indústria</b><b>Transporte</b></div><div><span>Produto</span><b>Fertilizantes</b><b>Defensivos</b><b>Sementes</b><b>Grãos</b></div></div><div class="info-note"><b>Exemplos da estrutura — classificação ainda não ativa.</b><p>A classificação automática e o motor de relevância ainda não estão ativos. Nenhuma publicação exibe marcadores inventados como se fossem dados processados.</p></div></section>'}
function renderNorma(){
 const q=user.normaClara||{used:0,limit:0};
 setActive("norma-clara");view.innerHTML=head("Compreensão","Norma Clara","Traduza cada artigo, parágrafo ou outro bloco jurídico para português claro e popular, mantendo o original intacto.")+'<section class="norma-product"><div class="legal-sample"><span>Como funciona</span><h2>Dentro de qualquer publicação</h2><p>Abra uma publicação no Acervo. Cada dispositivo tem seu próprio botão <b>Traduzir para português claro e popular</b>.</p><p>Cada bloco desbloqueado usa 1 da cota do seu plano. Blocos que você já abriu continuam disponíveis e não contam de novo.</p><a class="btn primary" href="#acervo">Abrir o acervo →</a></div><div class="norma-output"><span>SEU PLANO</span><p><b>'+n(q.used)+' de '+n(q.limit)+'</b> blocos usados neste mês.</p><span>PRINCÍPIOS</span><p>✓ O texto oficial nunca é substituído.<br>✓ Tradução por dispositivo jurídico.<br>✓ Sem interpretação de impacto nem recomendação.<br>✓ Leitura auxiliar gerada por IA, sempre identificada.</p></div></section>'}
function renderCompany(){setActive("empresas");view.innerHTML=head("Organização","Empresas","Empresas monitoradas dentro da sua conta.")+'<section class="surface company-page"><div class="company-hero"><div class="company-avatar" aria-hidden="true">'+esc((user.company||"E").charAt(0))+'</div><div><h2>'+esc(user.company)+'</h2><p>Empresa principal da conta de avaliação</p></div><button class="btn ghost" disabled aria-disabled="true">Editar cadastro · em breve</button></div><div class="company-fields"><div><span>CNPJ</span><b>Não informado</b></div><div><span>Regime tributário</span><b>Não informado</b></div><div><span>Estabelecimentos</span><b>0 cadastrados</b></div><div><span>Perfil Tributário</span><b>Não configurado</b></div></div></section>'}
function renderEstablishments(){setActive("estabelecimentos");view.innerHTML=head("Organização","Estabelecimentos","Filiais e unidades usadas para contextualizar a cobertura estadual.")+'<section class="empty-final"><div aria-hidden="true">＋</div><h2>Nenhum estabelecimento cadastrado</h2><p>O cadastro de matriz, filiais, armazéns, fazendas e indústrias estará disponível em breve e alimentará o contexto geográfico da empresa.</p><button class="btn primary" disabled aria-disabled="true">Adicionar estabelecimento · em breve</button></section>'}
function renderProfile(){setActive("perfil");const chips=list=>'<ul class="chip-static">'+list.map(x=>'<li>'+x+'</li>').join("")+'</ul>';view.innerHTML=head("Organização","Perfil Tributário","Contexto estruturado que será usado para priorizar publicações.")+'<div class="info-note"><b>Cadastro em desenvolvimento.</b><p>As dimensões abaixo mostram a estrutura do Perfil Tributário. A edição e a conexão com os Marcadores Tributários ainda não estão ativas.</p></div><section class="profile-columns"><div class="surface profile-block"><span>Segmentos</span><h2>O que a empresa faz</h2>'+chips(["Agronegócio","Indústria","Comércio","Serviços"])+'</div><div class="surface profile-block"><span>Operações</span><h2>Processos fiscais</h2>'+chips(["Venda","Compra","Transferência","Devolução","Importação","Exportação"])+'</div><div class="surface profile-block"><span>Tributos</span><h2>Temas monitorados</h2>'+chips(["ICMS","ISS","IBS","CBS","IPI"])+'</div></section>'}
function renderSettings(){const q=user.normaClara||{used:0,limit:0};setActive("configuracoes");view.innerHTML=head("Administração","Configurações","Conta, plano e período de avaliação.")+'<section class="surface settings-list"><div><span>Usuário</span><b>'+esc(user.name)+'</b><small>'+esc(user.email)+'</small></div><div><span>Empresa</span><b>'+esc(user.company)+'</b><small></small></div><div><span>Plano</span><b>Avaliação</b><small>'+esc(user.trialDaysRemaining)+' dias restantes</small></div><div><span>Norma Clara</span><b>'+n(q.used)+' de '+n(q.limit)+' blocos neste mês</b><small>cota do plano</small></div><div><span>Notificações</span><b>E-mail</b><small>em breve</small></div></section>'}

// ===== Roteamento =====
let lastRouteKey="";
function routeKey(){const [path,qs]=location.hash.slice(1).split("?");const p=new URLSearchParams(qs||"");p.delete("pub");return (path||"inicio")+"?"+p.toString()}
function route(){
 const [name0,qs]=(location.hash||"#inicio").slice(1).split("?");const name=name0||"inicio";
 const pub=new URLSearchParams(qs||"").get("pub");
 const key=routeKey();const pageChanged=key!==lastRouteKey;lastRouteKey=key;
 const drawer=document.getElementById("drawer");
 if(pageChanged){
  if(name==="acervo"){stateFromQuery(qs);renderAcervo()}
  else if(name==="publicacoes")renderFeed();
  else ({inicio:renderInicio,monitoramento:renderMonitor,fontes:renderSources,marcadores:renderMarkers,"norma-clara":renderNorma,empresas:renderCompany,estabelecimentos:renderEstablishments,perfil:renderProfile,configuracoes:renderSettings}[name]||(()=>{location.hash="#inicio"}))();
 }
 if(pub&&(!drawer.classList.contains("open")||drawer.dataset.pub!==pub)){drawer.dataset.pub=pub;openPublication(pub,false)}
 if(!pub&&drawer.classList.contains("open"))drawer.classList.remove("open");
}
document.getElementById("drawer-close").onclick=closePublication;
document.getElementById("drawer").onclick=e=>{if(e.target.id==="drawer")closePublication()};
new MutationObserver(()=>{const d=document.getElementById("drawer");if(!d.classList.contains("open")&&new URLSearchParams(location.hash.split("?")[1]||"").get("pub"))setPubInUrl(null)}).observe(document.getElementById("drawer"),{attributes:true,attributeFilter:["class"]});
document.getElementById("global-search").addEventListener("keydown",e=>{if(e.key==="Enter"){const q=e.target.value.trim();location.hash="#acervo"+(q?"?q="+encodeURIComponent(q):"")}});
addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();document.getElementById("global-search").focus()}});
addEventListener("hashchange",route);boot();
})();
