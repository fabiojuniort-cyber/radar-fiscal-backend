// Fotografias reais curadas no Wikimedia Commons (autoria e licença registradas e exibidas na legenda).
// Miniaturas de 1920 px servidas pelo Commons; nenhuma imagem é gerada por IA.
const ALL_UFS=[
{"uf": "AC", "name": "Acre", "capital": "Rio Branco", "place": "Centro de Rio Branco", "img": "https://upload.wikimedia.org/wikipedia/commons/9/91/Bairro_Centro_Rio_Branco_%28cropped%29.jpg", "author": "Agência de Notícias do Acre", "license": "CC BY 2.0", "page": "https://commons.wikimedia.org/wiki/File:Bairro_Centro_Rio_Branco_(cropped).jpg"},
{"uf": "AL", "name": "Alagoas", "capital": "Maceió", "place": "Farol da Ponta Verde", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f0/Ponta_Verde_Lighthouse_landscape_-_Macei%C3%B3%2C_Brazil_%28edited%29.jpg/1920px-Ponta_Verde_Lighthouse_landscape_-_Macei%C3%B3%2C_Brazil_%28edited%29.jpg", "author": "André Lage Freitas (derivações: Wilfredor, Aristeas)", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Ponta_Verde_Lighthouse_landscape_-_Maceió,_Brazil_(edited).jpg"},
{"uf": "AP", "name": "Amapá", "capital": "Macapá", "place": "Fortaleza de São José de Macapá", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/94/Fortaleza_de_S%C3%A3o_Jos%C3%A9_de_Macap%C3%A1.jpg/1920px-Fortaleza_de_S%C3%A3o_Jos%C3%A9_de_Macap%C3%A1.jpg", "author": "Athena Vieira", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Fortaleza_de_São_José_de_Macapá.jpg"},
{"uf": "AM", "name": "Amazonas", "capital": "Manaus", "place": "Teatro Amazonas", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/42/Noite_no_Teatro_Amazonas_%28cropped%29.jpg/1920px-Noite_no_Teatro_Amazonas_%28cropped%29.jpg", "author": "Susan Valentim", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Noite_no_Teatro_Amazonas_(cropped).jpg"},
{"uf": "BA", "name": "Bahia", "capital": "Salvador", "place": "Salvador", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c0/Salvador_BA_%28cropped%29_2.jpg/1920px-Salvador_BA_%28cropped%29_2.jpg", "author": "Fotos Gov/BA", "license": "CC BY 2.0", "page": "https://commons.wikimedia.org/wiki/File:Salvador_BA_(cropped)_2.jpg"},
{"uf": "CE", "name": "Ceará", "capital": "Fortaleza", "place": "Orla de Fortaleza", "img": "https://upload.wikimedia.org/wikipedia/commons/7/73/Fortaleza%2C_Brazil_%284%29_%28cropped%29.jpg", "author": "ME/Portal da Copa", "license": "CC BY-SA 3.0", "page": "https://commons.wikimedia.org/wiki/File:Fortaleza,_Brazil_(4)_(cropped).jpg"},
{"uf": "DF", "name": "Distrito Federal", "capital": "Brasília", "place": "Brasília", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2d/Planalto_Central_%28cropped%29.jpg/1920px-Planalto_Central_%28cropped%29.jpg", "author": "Arturdiasr", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Planalto_Central_(cropped).jpg"},
{"uf": "ES", "name": "Espírito Santo", "capital": "Vitória", "place": "Vitória", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/27/-2016-11-05_ao_13-_Vit%C3%B3ria_94_Romerito_Pontes_%2830875449812%29_%28cropped%29.jpg/1920px--2016-11-05_ao_13-_Vit%C3%B3ria_94_Romerito_Pontes_%2830875449812%29_%28cropped%29.jpg", "author": "Romerito Pontes", "license": "CC BY 2.0", "page": "https://commons.wikimedia.org/wiki/File:-2016-11-05_ao_13-_Vitória_94_Romerito_Pontes_(30875449812)_(cropped).jpg"},
{"uf": "GO", "name": "Goiás", "capital": "Goiânia", "place": "Goiânia", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fa/Panomara_Goi%C3%A2nia_2022.jpg/1920px-Panomara_Goi%C3%A2nia_2022.jpg", "author": "Boaventuravinicius", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Panomara_Goiânia_2022.jpg"},
{"uf": "MA", "name": "Maranhão", "capital": "São Luís", "place": "Centro Histórico de São Luís", "img": "https://upload.wikimedia.org/wikipedia/commons/0/09/Centro_Hist%C3%B3rico_de_S%C3%A3o_Lu%C3%ADs%2C_Maranh%C3%A3o%2C_Brasil_4.jpg", "author": "Andradewallace", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Centro_Histórico_de_São_Luís,_Maranhão,_Brasil_4.jpg"},
{"uf": "MT", "name": "Mato Grosso", "capital": "Cuiabá", "place": "Centro de Cuiabá", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/dc/Cuiab%C3%A1_center.jpg/1920px-Cuiab%C3%A1_center.jpg", "author": "Arne Müseler", "license": "CC BY-SA 3.0 DE", "page": "https://commons.wikimedia.org/wiki/File:Cuiabá_center.jpg"},
{"uf": "MS", "name": "Mato Grosso do Sul", "capital": "Campo Grande", "place": "Parque das Nações Indígenas", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d5/Tarde_quente.jpg/1920px-Tarde_quente.jpg", "author": "Barbosa7photos", "license": "CC BY-SA 3.0", "page": "https://commons.wikimedia.org/wiki/File:Tarde_quente.jpg"},
{"uf": "MG", "name": "Minas Gerais", "capital": "Belo Horizonte", "place": "Igreja de São Francisco de Assis, Pampulha", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Igrejinha_de_S%C3%A3o_Francisco_de_Assis_6.jpeg/1920px-Igrejinha_de_S%C3%A3o_Francisco_de_Assis_6.jpeg", "author": "Prandrade", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Igrejinha_de_São_Francisco_de_Assis_6.jpeg"},
{"uf": "PA", "name": "Pará", "capital": "Belém", "place": "Estação das Docas", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/70/Brazil_Bel%C3%A9m_Las_Docas_02.jpg/1920px-Brazil_Bel%C3%A9m_Las_Docas_02.jpg", "author": "Cayambe", "license": "CC BY-SA 3.0", "page": "https://commons.wikimedia.org/wiki/File:Brazil_Belém_Las_Docas_02.jpg"},
{"uf": "PB", "name": "Paraíba", "capital": "João Pessoa", "place": "Farol do Cabo Branco", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/eb/Joao_Pessoa_Paraiba_Farol_do_Cabo_Branco2.jpg/1920px-Joao_Pessoa_Paraiba_Farol_do_Cabo_Branco2.jpg", "author": "Pbendito", "license": "CC BY-SA 2.5", "page": "https://commons.wikimedia.org/wiki/File:Joao_Pessoa_Paraiba_Farol_do_Cabo_Branco2.jpg"},
{"uf": "PR", "name": "Paraná", "capital": "Curitiba", "place": "Jardim Botânico de Curitiba", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/19/Jardim_Bot%C3%A2nico_Centro_Curitiba.jpg/1920px-Jardim_Bot%C3%A2nico_Centro_Curitiba.jpg", "author": "Hicham El Banine", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Jardim_Botânico_Centro_Curitiba.jpg"},
{"uf": "PE", "name": "Pernambuco", "capital": "Recife", "place": "Ilha de Antônio Vaz", "img": "https://upload.wikimedia.org/wikipedia/commons/8/82/Antonio_Vaz_island_-_Recife%2C_Pernambuco%2C_Brazil_%28cropped%29.jpg", "author": "Portal da Copa/ME", "license": "CC BY 3.0 BR", "page": "https://commons.wikimedia.org/wiki/File:Antonio_Vaz_island_-_Recife,_Pernambuco,_Brazil_(cropped).jpg"},
{"uf": "PI", "name": "Piauí", "capital": "Teresina", "place": "Ponte Estaiada João Isidoro França", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/db/MauricioPokemon_Ponte_Estaiada_Teresina_PI_%2840914003022%29.jpg/1920px-MauricioPokemon_Ponte_Estaiada_Teresina_PI_%2840914003022%29.jpg", "author": "MTur Destinos", "license": "Domínio público", "page": "https://commons.wikimedia.org/wiki/File:MauricioPokemon_Ponte_Estaiada_Teresina_PI_(40914003022).jpg"},
{"uf": "RJ", "name": "Rio de Janeiro", "capital": "Rio de Janeiro", "place": "Rio de Janeiro", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/98/Cidade_Maravilhosa.jpg/1920px-Cidade_Maravilhosa.jpg", "author": "Rafael Rabello de Barros", "license": "CC BY-SA 3.0", "page": "https://commons.wikimedia.org/wiki/File:Cidade_Maravilhosa.jpg"},
{"uf": "RN", "name": "Rio Grande do Norte", "capital": "Natal", "place": "Forte dos Reis Magos", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6d/Forte-reis-magos.jpg/1920px-Forte-reis-magos.jpg", "author": "Onesimo.santos", "license": "CC BY-SA 3.0", "page": "https://commons.wikimedia.org/wiki/File:Forte-reis-magos.jpg"},
{"uf": "RS", "name": "Rio Grande do Sul", "capital": "Porto Alegre", "place": "Usina do Gasômetro", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/42/Usina_do_Gas%C3%B4metro_in_2025_%28zoom%29.jpg/1920px-Usina_do_Gas%C3%B4metro_in_2025_%28zoom%29.jpg", "author": "Heylenny", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Usina_do_Gasômetro_in_2025_(zoom).jpg"},
{"uf": "RO", "name": "Rondônia", "capital": "Porto Velho", "place": "Estrada de Ferro Madeira-Mamoré", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b8/Esta%C3%A7%C3%A3o_Locomotiva_18.jpg/1920px-Esta%C3%A7%C3%A3o_Locomotiva_18.jpg", "author": "Seravattavares", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Estação_Locomotiva_18.jpg"},
{"uf": "RR", "name": "Roraima", "capital": "Boa Vista", "place": "Orla de Boa Vista", "img": "https://upload.wikimedia.org/wikipedia/commons/1/1a/Orla_de_Boa_Vista_2.JPG", "author": "SallesNeto BR", "license": "CC BY-SA 3.0", "page": "https://commons.wikimedia.org/wiki/File:Orla_de_Boa_Vista_2.JPG"},
{"uf": "SC", "name": "Santa Catarina", "capital": "Florianópolis", "place": "Ponte Hercílio Luz", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/84/Ponte_Herc%C3%ADlio_Luz_FREITASFOTOS_002.jpg/1920px-Ponte_Herc%C3%ADlio_Luz_FREITASFOTOS_002.jpg", "author": "FREITASFOTOS", "license": "CC BY-SA 4.0", "page": "https://commons.wikimedia.org/wiki/File:Ponte_Hercílio_Luz_FREITASFOTOS_002.jpg"},
{"uf": "SE", "name": "Sergipe", "capital": "Aracaju", "place": "Aracaju", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8e/Ponte_tobias_barreto2.jpg/1920px-Ponte_tobias_barreto2.jpg", "author": "Roseane Botelho", "license": "CC BY-SA 3.0", "page": "https://commons.wikimedia.org/wiki/File:Ponte_tobias_barreto2.jpg"},
{"uf": "SP", "name": "São Paulo", "capital": "São Paulo", "place": "Ponte Estaiada Octávio Frias de Oliveira · Brooklin", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0e/Ponte_estaiada_Octavio_Frias_-_Sao_Paulo.jpg/1920px-Ponte_estaiada_Octavio_Frias_-_Sao_Paulo.jpg", "author": "Marcosleal", "license": "CC BY-SA 3.0", "page": "https://commons.wikimedia.org/wiki/File:Ponte_estaiada_Octavio_Frias_-_Sao_Paulo.jpg"},
{"uf": "TO", "name": "Tocantins", "capital": "Palmas", "place": "Palmas", "img": "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/23/FlavioAndre_UrbanismoeOrganizacao_Palmas_TO_%2840212595195%29.jpg/1920px-FlavioAndre_UrbanismoeOrganizacao_Palmas_TO_%2840212595195%29.jpg", "author": "MTur Destinos", "license": "Domínio público", "page": "https://commons.wikimedia.org/wiki/File:FlavioAndre_UrbanismoeOrganizacao_Palmas_TO_(40212595195).jpg"}
];
const SP=ALL_UFS.find(x=>x.uf==="SP");
function sampleFour(){
  const pool=ALL_UFS.filter(x=>x.uf!=="SP").slice();
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  return pool.slice(0,4);
}
// Status vem de /api/public/coverage; na falta de confirmação, "Em implantação" (nunca afirmar cobertura sem o backend).
const sessionStates=[SP,...sampleFour()].map(x=>({...x,status:"Em implantação",available:false}));
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let index=0,timer=null,paused=false;
const reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
async function loadCoverage(){
  try{
    const r=await fetch("/api/public/coverage");if(!r.ok)throw new Error("coverage");
    const c=await r.json();
    sessionStates.forEach(s=>{s.available=c.states&&c.states[s.uf]==="DISPONIVEL";s.status=s.available?"Disponível":"Em implantação"});
    const list=document.getElementById("federal-coverage");
    if(list)list.innerHTML=c.federal.map(f=>'<div class="source-row"><strong>'+esc(f.label)+'</strong><span class="pill'+(f.status==="DISPONIVEL"?'':' wip')+'">'+(f.status==="DISPONIVEL"?'Disponível'+(f.via?' · via '+esc(f.via):''):'Em implantação')+'</span></div>').join("");
  }catch(e){
    const list=document.getElementById("federal-coverage");
    if(list)list.querySelectorAll(".pill").forEach(p=>{p.className="pill neutral";p.textContent="Status indisponível no momento"});
  }
  drawStatus();
}
function drawStatus(){
  const s=sessionStates[index];
  document.getElementById("state-status").innerHTML='<span class="status"><span class="dot" style="background:'+(s.available?'#00E6D6':'#FFB84D')+'"></span>'+s.status+'</span>';
}

function draw(){
  const s=sessionStates[index];
  document.getElementById("state-title").textContent=s.name+" / "+s.uf;
  document.getElementById("state-capital").textContent=s.capital;
  document.getElementById("state-place").textContent=s.place;
  drawStatus();
  document.getElementById("carousel-count").textContent=(index+1)+" / "+sessionStates.length;
  document.getElementById("state-frame").setAttribute("aria-label",s.name+", slide "+(index+1)+" de "+sessionStates.length);
  document.getElementById("state-dots").innerHTML=sessionStates.map((x,i)=>'<button type="button" class="'+(i===index?'active':'')+'" aria-label="Ir para '+esc(x.name)+'" '+(i===index?'aria-current="true"':'')+' data-go="'+i+'"></button>').join("");
  document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{index=Number(b.dataset.go);draw();restart()});
  const img=document.getElementById("state-img"),loading=document.getElementById("photo-loading");
  loading.style.display="grid";loading.textContent="Carregando fotografia…";img.style.opacity="0";
  img.onload=()=>{loading.style.display="none";img.style.opacity="1"};
  img.onerror=()=>{loading.style.display="grid";loading.textContent="Fotografia não disponível"};
  img.alt=s.place+" — "+s.capital+"/"+s.uf;
  img.src=s.img;
  document.getElementById("state-caption").innerHTML=esc(s.place)+' — '+esc(s.capital)+'/'+s.uf+' · Foto: <a href="'+esc(s.page)+'" target="_blank" rel="noopener">'+esc(s.author)+', '+esc(s.license)+'</a>';
  const nx=sessionStates[(index+1)%sessionStates.length];new Image().src=nx.img;
}
function restart(){clearInterval(timer);if(!paused&&!reduceMotion)timer=setInterval(next,15000)}
function stop(){clearInterval(timer)}
function next(){index=(index+1)%sessionStates.length;draw();restart()}
function prev(){index=(index-1+sessionStates.length)%sessionStates.length;draw();restart()}
function setPaused(v){paused=v;const b=document.getElementById("state-pause");b.setAttribute("aria-pressed",String(v));b.setAttribute("aria-label",v?"Retomar rotação automática":"Pausar rotação automática");b.textContent=v?"▶":"❚❚";restart()}
document.getElementById("state-next").addEventListener("click",next);
document.getElementById("state-prev").addEventListener("click",prev);
document.getElementById("state-pause").addEventListener("click",()=>setPaused(!paused));
const frame=document.getElementById("state-frame");
frame.addEventListener("mouseenter",stop);frame.addEventListener("mouseleave",restart);
frame.addEventListener("focusin",stop);frame.addEventListener("focusout",e=>{if(!frame.contains(e.relatedTarget))restart()});
frame.addEventListener("keydown",e=>{if(e.key==="ArrowRight"){e.preventDefault();next()}if(e.key==="ArrowLeft"){e.preventDefault();prev()}});
let touchX=null;
frame.addEventListener("touchstart",e=>{touchX=e.touches[0].clientX;stop()},{passive:true});
frame.addEventListener("touchend",e=>{if(touchX==null)return;const dx=e.changedTouches[0].clientX-touchX;touchX=null;if(Math.abs(dx)>40){dx<0?next():prev()}else restart()},{passive:true});
if(reduceMotion)setPaused(true);
async function loadLatest(){
  const list=document.getElementById("radar-list"),sub=document.getElementById("radar-sub");if(!list)return;
  try{
    const r=await fetch("/api/public/latest");if(!r.ok)throw new Error("latest");
    const d=await r.json();
    const day=v=>{const k=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo"}).format(new Date(v));const t=new Date();const y=new Date(t);y.setDate(t.getDate()-1);const f=x=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo"}).format(x);return k===f(t)?"Hoje":k===f(y)?"Ontem":new Date(v).toLocaleDateString("pt-BR")};
    list.innerHTML=d.items.length?d.items.map(p=>'<article><div class="meta"><span>'+esc(p.source_name)+'</span><span>'+day(p.first_collected_at)+'</span></div><strong>'+esc(p.title)+'</strong><div class="radar-type">'+esc(p.act_type||"")+(p.uf?' · '+esc(p.uf):'')+'</div></article>').join(""):'<article><strong class="muted">Sem capturas recentes.</strong></article>';
    if(d.stats&&sub){
      const mins=d.stats.last_collection_at?Math.max(1,Math.round((Date.now()-new Date(d.stats.last_collection_at))/60000)):null;
      sub.textContent=new Intl.NumberFormat("pt-BR").format(d.stats.total)+" publicações preservadas"+(mins!=null?" · última coleta há "+(mins<60?mins+" min":Math.round(mins/60)+" h"):"");
    }
  }catch(e){list.innerHTML='<article><strong class="muted">Capturas indisponíveis no momento.</strong></article>'}
}
draw();restart();loadCoverage();loadLatest();
