
(function(){
 const form=document.getElementById("search-form"),q=document.getElementById("search-q"),list=document.getElementById("archive-list"),status=document.getElementById("archive-status");
 const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
 function fmt(d){if(!d)return "Data não informada";const x=new Date(d+"T00:00:00");return x.toLocaleDateString("pt-BR");}
 async function load(){
   status.textContent="Consultando o acervo real…"; list.innerHTML="";
   const url="/api/publications?limit=50"+(q.value.trim()?"&q="+encodeURIComponent(q.value.trim()):"");
   const r=await fetch(url,{credentials:"same-origin"}); if(r.status===401){location.href="/login.html";return}
   const data=await r.json(); if(!r.ok){status.textContent="Não foi possível consultar o acervo agora.";return}
   status.textContent=data.items.length+" publicação(ões) encontrada(s)";
   if(!data.items.length){list.innerHTML='<div class="archive-empty">Nenhuma publicação encontrada para esta busca.</div>';return}
   list.innerHTML=data.items.map(p=>'<article class="archive-item"><div class="archive-date">'+esc(fmt(p.published_on))+'</div><div class="archive-content"><div class="archive-meta">'+esc(p.source_name||p.agency||"Fonte oficial")+' · '+esc(p.act_type||"Publicação")+(p.uf?' · '+esc(p.uf):'')+'</div><h2>'+esc(p.title)+'</h2><div class="archive-sub">'+esc([p.act_number,p.agency].filter(Boolean).join(" · "))+'</div>'+(p.relevant_excerpt?'<p>'+esc(p.relevant_excerpt).slice(0,340)+'</p>':'')+'<div class="archive-links">'+(p.primary_official_url?'<a target="_blank" rel="noopener" href="'+esc(p.primary_official_url)+'">Abrir fonte oficial ↗</a>':'')+'</div></div></article>').join("");
 }
 form.addEventListener("submit",e=>{e.preventDefault();load()}); load();
})();