
(function(){
const view=document.getElementById("product-view");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const n=v=>new Intl.NumberFormat("pt-BR").format(Number(v||0));
const date=v=>v?new Date(v).toLocaleDateString("pt-BR"):"—";
const dt=v=>v?new Date(v).toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"}):"—";
const healthLabel=h=>({OPERATIONAL:"Operacional",UNSTABLE:"Instável",UNAVAILABLE:"Indisponível",NOT_CONSULTED:"Não consultada"})[h]||h;
const healthClass=h=>({OPERATIONAL:"ok",UNSTABLE:"warn",UNAVAILABLE:"bad",NOT_CONSULTED:"neutral"})[h]||"neutral";
let user=null,filterOptions=null,filtersOpen=true,publicationState={page:1,q:"",source:"",uf:"",jurisdiction:"",actType:"",agency:"",dateFrom:"",dateTo:"",period:"",mode:"acervo"};

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


async function api(url){const r=await fetch(url,{credentials:"same-origin"});if(r.status===401){location.href="/login.html";throw new Error("unauthorized")}const data=await r.json();if(!r.ok)throw new Error(data.error||"request_failed");return data}
async function boot(){const me=await api("/api/me");user=me.user;document.getElementById("top-company").textContent=user.company;document.getElementById("top-user").textContent=user.name;route()}
function setActive(name){document.querySelectorAll(".product-nav a[data-route]").forEach(a=>a.classList.toggle("active",a.dataset.route===name))}
function head(kicker,title,subtitle,actions=""){return '<div class="product-page-head"><div><div class="eyebrow">'+kicker+'</div><h1>'+title+'</h1><p>'+subtitle+'</p></div>'+actions+'</div>'}
function metric(label,value,sub=""){return '<div class="metric"><span>'+label+'</span><b>'+value+'</b><small>'+sub+'</small></div>'}

async function renderInicio(){
 setActive("inicio");view.innerHTML=head("Visão Geral","Bom dia, "+esc((user.name||"").split(" ")[0])+".","O que aconteceu no monitoramento tributário e o que merece atenção agora.");
 const d=await api("/api/dashboard");const m=d.metrics;
 view.innerHTML+= '<section class="metric-strip">'+
 metric("Acervo total",n(m.total_publications),"publicações armazenadas")+
 metric("Capturadas hoje",n(m.publications_today),"novos dispositivos/publicações")+
 metric("Novas versões hoje",n(m.new_versions_today),"alterações de conteúdo")+
 metric("Fontes ativas",n(m.active_sources),n(m.runs_24h)+" execuções nas últimas 24h")+
 '</section>';
 const portfolio=[
 ["Radar Tributário","Mudanças recentes e priorização","publicacoes"],
 ["Monitor Estadual","Acompanhe UFs e fontes estaduais","fontes"],
 ["Norma Clara","Português claro e popular","norma-clara"],
 ["Perfil Tributário","Contexto da empresa","perfil"],
 ["Busca Inteligente","Consulte todo o acervo","acervo"]
 ];
 view.innerHTML+='<section class="module-section"><div class="section-title"><div><span>Portfólio TriBusca</span><h2>Atalhos para o que você precisa</h2></div></div><div class="module-list">'+portfolio.map((x,i)=>'<a href="#'+x[2]+'" class="module-row"><span class="module-num">0'+(i+1)+'</span><div><b>'+x[0]+'</b><small>'+x[1]+'</small></div><span class="arrow">→</span></a>').join("")+'</div></section>';
 view.innerHTML+='<section class="dashboard-grid"><div class="surface"><div class="surface-head"><div><span>Últimas capturas</span><h2>Entraram agora no acervo</h2></div><a href="#publicacoes">Ver todas →</a></div><div class="recent-list">'+d.latest.map(p=>'<button class="recent-row" data-pub="'+p.id+'"><span>'+date(p.published_on)+'</span><div><b>'+esc(p.title)+'</b><small>'+esc(p.source_name)+' · '+esc(p.act_type||"Publicação")+(p.uf?' · '+p.uf:'')+'</small></div><em>→</em></button>').join("")+'</div></div><div class="surface source-mini"><div class="surface-head"><div><span>Saúde operacional</span><h2>Fontes</h2></div><a href="#monitoramento">Abrir central →</a></div><div class="health-summary"><div><b>'+n(d.sourcesSummary.OPERATIONAL||0)+'</b><span>Operacionais</span></div><div><b>'+n(d.sourcesSummary.UNSTABLE||0)+'</b><span>Instáveis</span></div><div><b>'+n(d.sourcesSummary.UNAVAILABLE||0)+'</b><span>Indisponíveis</span></div></div><div class="mini-sources">'+d.sources.slice(0,6).map(s=>'<div><span class="health-dot '+healthClass(s.health)+'"></span><b>'+esc(s.name)+'</b><small>'+healthLabel(s.health)+'</small></div>').join("")+'</div></div></section>';
 bindPublicationClicks();
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
 if(publicationState.dateFrom||publicationState.dateTo)chips.push(["period","Período: "+(publicationState.dateFrom?date(publicationState.dateFrom):"início")+" → "+(publicationState.dateTo?date(publicationState.dateTo):"hoje")]);
 if(!chips.length)return "";
 return '<div class="active-filters">'+chips.map(c=>'<button type="button" data-clear-filter="'+c[0]+'">'+esc(c[1])+' <span>×</span></button>').join("")+'<button type="button" class="clear-all" data-clear-filter="all">Limpar todos</button></div>';
}
function publicationFilters(){
 const o=filterOptions||{actTypes:[],agencies:[],sources:[],ufs:[]};
 return '<div class="archive-filter-shell">'+
 '<form id="pub-filter" class="archive-search-row">'+
   '<div class="archive-search"><span>⌕</span><input id="pub-q" value="'+esc(publicationState.q)+'" placeholder="Buscar por título, número, órgão ou conteúdo…"></div>'+
   '<button id="toggle-filters" class="btn filter-toggle '+(filtersOpen?"active":"")+'" type="button">Filtros <span id="filter-count"></span></button>'+
   '<button class="btn primary">Buscar</button>'+
 '</form>'+
 '<div id="advanced-filters" class="advanced-filters '+(filtersOpen?"open":"")+'">'+
   '<label><span>Esfera</span><select id="pub-j"><option value="">Todas</option><option value="FEDERAL" '+(publicationState.jurisdiction==="FEDERAL"?"selected":"")+'>Federal</option><option value="STATE" '+(publicationState.jurisdiction==="STATE"?"selected":"")+'>Estadual</option></select></label>'+
   '<label><span>Fonte oficial</span><select id="pub-source"><option value="">Todas as fontes</option>'+optionList(o.sources,publicationState.source,"label")+'</select></label>'+
   '<label><span>Tipo de ato</span><select id="pub-type"><option value="">Todos os tipos</option>'+optionList(o.actTypes,publicationState.actType)+'</select></label>'+
   '<label><span>Órgão</span><select id="pub-agency"><option value="">Todos os órgãos</option>'+optionList(o.agencies,publicationState.agency)+'</select></label>'+
   '<label><span>UF</span><select id="pub-uf"><option value="">Todas</option>'+optionList(o.ufs,publicationState.uf)+'</select></label>'+
   '<label><span>Período</span><select id="pub-period"><option value="" '+(!publicationState.period?"selected":"")+'>Todo o período</option><option value="today" '+(publicationState.period==="today"?"selected":"")+'>Hoje</option><option value="7d" '+(publicationState.period==="7d"?"selected":"")+'>Últimos 7 dias</option><option value="30d" '+(publicationState.period==="30d"?"selected":"")+'>Últimos 30 dias</option><option value="90d" '+(publicationState.period==="90d"?"selected":"")+'>Últimos 90 dias</option><option value="year" '+(publicationState.period==="year"?"selected":"")+'>Este ano</option><option value="custom" '+(publicationState.period==="custom"?"selected":"")+'>Personalizado</option></select></label>'+
   '<label class="custom-date '+(publicationState.period==="custom"?"show":"")+'"><span>De</span><input id="pub-from" type="date" value="'+esc(publicationState.dateFrom)+'"></label>'+
   '<label class="custom-date '+(publicationState.period==="custom"?"show":"")+'"><span>Até</span><input id="pub-to" type="date" value="'+esc(publicationState.dateTo)+'"></label>'+
   '<div class="filter-actions"><button id="apply-filters" class="btn primary" type="button">Aplicar filtros</button><button id="clear-filter" class="btn ghost" type="button">Limpar</button></div>'+
 '</div>'+
 '<div id="active-filter-area">'+activeFilterChips()+'</div>'+
 '</div>'
}
function isoLocal(d){return d.toISOString().slice(0,10)}
function applyPeriod(){
 const period=document.getElementById("pub-period").value;publicationState.period=period;
 if(period==="custom"){
   publicationState.dateFrom=document.getElementById("pub-from").value||"";
   publicationState.dateTo=document.getElementById("pub-to").value||"";
   return;
 }
 if(!period){publicationState.dateFrom="";publicationState.dateTo="";return}
 const now=new Date(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),from=new Date(today);
 publicationState.dateTo=isoLocal(today);
 if(period==="today")from.setDate(today.getDate());
 if(period==="7d")from.setDate(today.getDate()-6);
 if(period==="30d")from.setDate(today.getDate()-29);
 if(period==="90d")from.setDate(today.getDate()-89);
 if(period==="year"){from.setMonth(0,1)}
 publicationState.dateFrom=isoLocal(from);
}
function readFilterForm(){
 publicationState.page=1;
 publicationState.q=document.getElementById("pub-q").value.trim();
 publicationState.jurisdiction=document.getElementById("pub-j").value;
 publicationState.source=document.getElementById("pub-source").value;
 publicationState.actType=document.getElementById("pub-type").value;
 publicationState.agency=document.getElementById("pub-agency").value;
 publicationState.uf=document.getElementById("pub-uf").value;
 applyPeriod();
}
function refreshFilterChrome(){
 const area=document.getElementById("active-filter-area");if(area)area.innerHTML=activeFilterChips();
 const count=["q","jurisdiction","source","actType","agency","uf"].filter(k=>publicationState[k]).length+(publicationState.dateFrom||publicationState.dateTo?1:0);
 const badge=document.getElementById("filter-count");if(badge)badge.textContent=count?"("+count+")":"";
 document.querySelectorAll("[data-clear-filter]").forEach(btn=>btn.onclick=()=>{
   const key=btn.dataset.clearFilter;
   if(key==="all"){publicationState={...publicationState,page:1,q:"",uf:"",jurisdiction:"",source:"",actType:"",agency:"",dateFrom:"",dateTo:"",period:""}}
   else if(key==="period"){publicationState.dateFrom="";publicationState.dateTo="";publicationState.period=""}
   else publicationState[key]="";
   renderPublications(publicationState.mode);
 });
}
async function renderPublications(mode){
 const isArchive=mode==="acervo";setActive(isArchive?"acervo":"publicacoes");publicationState.mode=mode;
 if(!filterOptions){try{filterOptions=await api("/api/publication-filter-options")}catch(e){filterOptions={actTypes:[],agencies:[],sources:[],ufs:[]}}}
 view.innerHTML=head(isArchive?"Acervo":"Inteligência",isArchive?"Acervo Tributário":"Publicações","Consulte publicações oficiais já capturadas e preservadas pela TriBusca.")+publicationFilters()+'<div id="pub-results" class="surface publications-surface"><div class="page-loading">Consultando banco real…</div></div>';
 const form=document.getElementById("pub-filter");
 form.onsubmit=e=>{e.preventDefault();readFilterForm();refreshFilterChrome();loadPublications()};
 document.getElementById("toggle-filters").onclick=()=>{filtersOpen=!filtersOpen;document.getElementById("advanced-filters").classList.toggle("open",filtersOpen);document.getElementById("toggle-filters").classList.toggle("active",filtersOpen)};
 document.getElementById("pub-period").onchange=e=>{document.querySelectorAll(".custom-date").forEach(x=>x.classList.toggle("show",e.target.value==="custom"))};
 document.getElementById("apply-filters").onclick=()=>{readFilterForm();refreshFilterChrome();loadPublications()};
 document.getElementById("clear-filter").onclick=()=>{publicationState={...publicationState,page:1,q:"",uf:"",jurisdiction:"",source:"",actType:"",agency:"",dateFrom:"",dateTo:"",period:""};renderPublications(mode)};
 refreshFilterChrome();loadPublications();
}
async function loadPublications(){
 const params=new URLSearchParams({page:String(publicationState.page),pageSize:"25"});["q","source","uf","jurisdiction","actType","agency","dateFrom","dateTo"].forEach(k=>{if(publicationState[k])params.set(k,publicationState[k])});
 const d=await api("/api/publications?"+params.toString());const el=document.getElementById("pub-results");
 el.innerHTML='<div class="results-head"><div><b>'+n(d.total)+'</b> publicação(ões)</div><span>Página '+d.page+' de '+d.totalPages+'</span></div>'+
 '<div class="publication-table"><div class="publication-tr header"><span>Data</span><span>Publicação</span><span>Fonte</span><span>Escopo</span><span></span></div>'+
 d.items.map(p=>'<button class="publication-tr" data-pub="'+p.id+'"><span>'+date(p.published_on)+'</span><span><b>'+esc(p.title)+'</b><small>'+esc([p.act_type,p.act_number,p.agency].filter(Boolean).join(" · "))+'</small></span><span>'+esc(p.source_name||p.agency||"—")+'</span><span>'+esc(p.jurisdiction_level==="FEDERAL"?"Federal":(p.uf||"Estadual"))+'</span><span>→</span></button>').join("")+'</div>'+
 '<div class="pagination"><button class="btn ghost" id="prev-page" '+(d.page<=1?"disabled":"")+'>← Anterior</button><span>'+n(d.total)+' resultados</span><button class="btn ghost" id="next-page" '+(d.page>=d.totalPages?"disabled":"")+'>Próxima →</button></div>';
 document.getElementById("prev-page").onclick=()=>{if(publicationState.page>1){publicationState.page--;loadPublications();scrollTo(0,0)}};
 document.getElementById("next-page").onclick=()=>{if(publicationState.page<d.totalPages){publicationState.page++;loadPublications();scrollTo(0,0)}};
 bindPublicationClicks();
}
function bindPublicationClicks(){document.querySelectorAll("[data-pub]").forEach(b=>b.onclick=()=>openPublication(b.dataset.pub))}
async function openPublication(id){
 const drawer=document.getElementById("drawer"),content=document.getElementById("drawer-content");drawer.classList.add("open");drawer.setAttribute("aria-hidden","false");content.innerHTML='<div class="page-loading">Abrindo publicação…</div>';
 const d=await api("/api/publications/"+id),p=d.publication;
 const segments=d.segments||[];
 const documentHtml=segments.length
   ?segments.map((s,i)=>'<section class="legal-segment"><div class="segment-ref">'+esc(s.label)+'</div><div class="segment-official">'+esc(s.text)+'</div>'+(s.unlocked
       ?'<button class="norma-segment-btn" data-index="'+i+'" data-open="1">Ocultar Norma Clara</button><div class="norma-inline open">'+normaBox(s.translation)+'</div>'
       :'<button class="norma-segment-btn" data-index="'+i+'">Traduzir para português claro e popular</button><div class="norma-inline"></div>')+'</section>').join("")
   :'<div class="document-empty">O texto integral ainda não está armazenado para esta publicação.</div>';
 content.innerHTML='<div class="drawer-eyebrow">'+esc(p.act_type||"Publicação oficial")+'</div><h1>'+esc(p.title)+'</h1><div class="detail-meta">'+[p.act_number,p.agency,p.uf,date(p.published_on)].filter(Boolean).map(esc).join(" · ")+'</div><div class="detail-actions">'+(p.primary_official_url?'<a class="btn primary" target="_blank" rel="noopener" href="'+esc(p.primary_official_url)+'">Fonte oficial ↗</a>':'')+'<span class="norma-ready" id="nc-quota">Norma Clara por dispositivo</span></div><div class="detail-tabs"><b>Documento oficial</b><span>Versão '+esc(p.version_no||1)+'</span></div><article class="legal-document">'+documentHtml+'</article><section class="origin-box"><b>Rastreabilidade</b>'+d.origins.map(o=>'<div><span>'+esc(o.source_name)+'</span><a target="_blank" rel="noopener" href="'+esc(o.official_url)+'">Abrir origem ↗</a></div>').join("")+'</section>';
 content.querySelectorAll(".norma-segment-btn").forEach(btn=>{
   btn.onclick=()=>{
     const idx=Number(btn.dataset.index),box=btn.closest(".legal-segment").querySelector(".norma-inline");
     if(btn.dataset.open==="1"){box.classList.toggle("open");btn.textContent=box.classList.contains("open")?"Ocultar Norma Clara":"Mostrar Norma Clara";return}
     translateSegment(btn,p.version_id,segments[idx].hash);
   };
 });
 updateQuota(d.normaClara);
}
async function renderMonitor(){
 setActive("monitoramento");view.innerHTML=head("Monitoramento","Central de Monitoramento","Saúde operacional das fontes separada da cobertura legislativa.");
 const d=await api("/api/sources");const op=d.items.filter(x=>x.health==="OPERATIONAL").length,un=d.items.filter(x=>x.health==="UNSTABLE").length,bad=d.items.filter(x=>x.health==="UNAVAILABLE").length,none=d.items.filter(x=>x.health==="NOT_CONSULTED").length;
 view.innerHTML+='<section class="metric-strip four">'+metric("Operacionais",op,"última execução saudável")+metric("Instáveis",un,"atenção operacional")+metric("Indisponíveis",bad,"falha na última execução")+metric("Não consultadas",none,"sem tentativa registrada")+'</section>'+sourceTable(d.items,true);
}
async function renderSources(){
 setActive("fontes");view.innerHTML=head("Monitoramento","Fontes Oficiais","Conectores, última consulta, tentativas e volume capturado.");
 const d=await api("/api/sources");view.innerHTML+=sourceTable(d.items,false);
}
function sourceTable(items,central){
 return '<section class="surface source-table-wrap"><div class="results-head"><div><b>'+items.length+'</b> fontes cadastradas</div><span>'+ (central?"Status operacional em tempo real do banco":"Cobertura e conectores") +'</span></div><div class="source-table"><div class="source-tr header"><span>Fonte</span><span>Status</span><span>Última tentativa</span><span>Tentativas 24h</span><span>Hoje</span><span>Total</span></div>'+items.map(s=>'<div class="source-tr"><span><b>'+esc(s.name)+'</b><small>'+esc(s.code)+(s.uf?' · '+s.uf:'')+'</small></span><span><i class="health-dot '+healthClass(s.health)+'"></i>'+healthLabel(s.health)+'</span><span>'+dt(s.last_attempt_at)+'</span><span>'+n(s.attempts_24h||0)+'</span><span>'+n(s.publications_today||0)+'</span><span>'+n(s.publications_total||0)+'</span></div>').join("")+'</div></section>';
}
function renderMarkers(){setActive("marcadores");view.innerHTML=head("Inteligência","Marcadores Tributários","A taxonomia controlada que conectará publicações, busca e Perfil Tributário.")+'<section class="editorial-page"><div class="taxonomy-demo"><div><span>Tributo</span><b>ICMS</b><b>ISS</b><b>IBS</b><b>CBS</b></div><div><span>Operação</span><b>Venda</b><b>Transferência</b><b>Devolução</b><b>Formação de lote</b></div><div><span>Segmento</span><b>Agronegócio</b><b>Indústria</b><b>Transporte</b></div><div><span>Produto</span><b>Fertilizantes</b><b>Defensivos</b><b>Sementes</b><b>Grãos</b></div></div><div class="info-note"><b>Estrutura preparada para o produto.</b><p>A classificação automática e o motor de matching ainda não estão ativos neste protótipo. Não exibimos marcadores inventados como se fossem dados processados.</p></div></section>'}
function renderNorma(){setActive("norma-clara");view.innerHTML=head("Compreensão","Norma Clara","Traduza cada artigo, parágrafo, inciso ou outro bloco jurídico para português claro e popular, mantendo o original intacto.")+'<section class="norma-product"><div class="legal-sample"><span>Como funciona</span><h2>Dentro de qualquer publicação</h2><p>Abra uma publicação no Acervo. Cada unidade jurídica possui seu próprio botão <b>Traduzir para português claro e popular</b>.</p><p>A tradução é vinculada à versão exata do documento, reutilizada entre usuários e regenerada somente quando uma nova Norma Clara Engine for homologada.</p><a class="btn primary" href="#acervo">Abrir o acervo →</a></div><div class="norma-output"><span>PRINCÍPIOS</span><p>✓ Texto oficial nunca é substituído.<br>✓ Tradução por bloco jurídico.<br>✓ Sem interpretação de impacto.<br>✓ Cache compartilhado no PostgreSQL.<br>✓ Controle de concorrência para evitar chamadas duplicadas.<br>✓ Engine versionada, independente do nome público do modelo.</p></div></section>'}
function renderCompany(){setActive("empresas");view.innerHTML=head("Organização","Empresas","Entidades monitoradas dentro da sua conta.")+'<section class="surface company-page"><div class="company-hero"><div class="company-avatar">'+esc((user.company||"E").charAt(0))+'</div><div><h2>'+esc(user.company)+'</h2><p>Empresa principal da sessão de demonstração</p></div><button class="btn ghost">Editar cadastro</button></div><div class="company-fields"><div><span>CNPJ</span><b>Não informado</b></div><div><span>Regime tributário</span><b>Não informado</b></div><div><span>Estabelecimentos</span><b>0 cadastrados</b></div><div><span>Perfil Tributário</span><b>Em configuração</b></div></div></section>'}
function renderEstablishments(){setActive("estabelecimentos");view.innerHTML=head("Organização","Estabelecimentos","Filiais e unidades usadas para contextualizar cobertura estadual.")+'<section class="empty-final"><div>＋</div><h2>Nenhum estabelecimento cadastrado</h2><p>Cadastre matriz, filiais, armazéns, fazendas, indústrias ou outras unidades para alimentar o contexto geográfico da empresa.</p><button class="btn primary">Adicionar estabelecimento</button></section>'}
function renderProfile(){setActive("perfil");view.innerHTML=head("Organização","Perfil Tributário","Contexto estruturado usado para priorizar publicações.")+'<section class="profile-columns"><div class="surface profile-block"><span>Segmentos</span><h2>O que a empresa faz</h2><div class="chip-editor"><button>Agronegócio</button><button>Indústria</button><button>Comércio</button><button>Serviços</button></div></div><div class="surface profile-block"><span>Operações</span><h2>Processos fiscais</h2><div class="chip-editor"><button>Venda</button><button>Compra</button><button>Transferência</button><button>Devolução</button><button>Importação</button><button>Exportação</button></div></div><div class="surface profile-block"><span>Tributos</span><h2>Temas monitorados</h2><div class="chip-editor"><button>ICMS</button><button>ISS</button><button>IBS</button><button>CBS</button><button>IPI</button></div></div></section><div class="info-note"><b>Próxima integração</b><p>Este perfil será conectado aos Marcadores Tributários para gerar relevância explicável por empresa.</p></div>'}
function renderSettings(){setActive("configuracoes");view.innerHTML=head("Administração","Configurações","Conta, preferências e informações do período de avaliação.")+'<section class="surface settings-list"><div><span>Usuário</span><b>'+esc(user.name)+'</b><small>'+esc(user.email)+'</small></div><div><span>Empresa</span><b>'+esc(user.company)+'</b></div><div><span>Plano</span><b>Período de avaliação</b><small>7 dias</small></div><div><span>Notificações</span><b>E-mail</b><small>Configuração futura</small></div></section>'}
function route(){
 const name=(location.hash||"#inicio").slice(1).split("?")[0];
 if(name==="inicio")return renderInicio();
 if(name==="publicacoes")return renderPublications("publicacoes");
 if(name==="acervo")return renderPublications("acervo");
 if(name==="monitoramento")return renderMonitor();
 if(name==="fontes")return renderSources();
 if(name==="marcadores")return renderMarkers();
 if(name==="norma-clara")return renderNorma();
 if(name==="empresas")return renderCompany();
 if(name==="estabelecimentos")return renderEstablishments();
 if(name==="perfil")return renderProfile();
 if(name==="configuracoes")return renderSettings();
 location.hash="#inicio";
}
document.getElementById("drawer-close").onclick=()=>{document.getElementById("drawer").classList.remove("open")};
document.getElementById("drawer").onclick=e=>{if(e.target.id==="drawer")document.getElementById("drawer").classList.remove("open")};
document.getElementById("global-search").addEventListener("keydown",e=>{if(e.key==="Enter"){publicationState.q=e.target.value.trim();publicationState.page=1;location.hash="#acervo";setTimeout(()=>renderPublications("acervo"),0)}});
addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();document.getElementById("global-search").focus()}});
addEventListener("hashchange",route);boot();
})();