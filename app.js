
const ALL_UFS=[
 {uf:"AC",name:"Acre",capital:"Rio Branco",wiki:"Palácio Rio Branco (Acre)"},
 {uf:"AL",name:"Alagoas",capital:"Maceió",wiki:"Praia de Pajuçara"},
 {uf:"AP",name:"Amapá",capital:"Macapá",wiki:"Fortaleza de São José de Macapá"},
 {uf:"AM",name:"Amazonas",capital:"Manaus",wiki:"Teatro Amazonas"},
 {uf:"BA",name:"Bahia",capital:"Salvador",wiki:"Elevador Lacerda"},
 {uf:"CE",name:"Ceará",capital:"Fortaleza",wiki:"Praia de Iracema"},
 {uf:"DF",name:"Distrito Federal",capital:"Brasília",wiki:"Congresso Nacional do Brasil"},
 {uf:"ES",name:"Espírito Santo",capital:"Vitória",wiki:"Terceira Ponte"},
 {uf:"GO",name:"Goiás",capital:"Goiânia",wiki:"Centro Cultural Oscar Niemeyer"},
 {uf:"MA",name:"Maranhão",capital:"São Luís",wiki:"Centro Histórico de São Luís"},
 {uf:"MT",name:"Mato Grosso",capital:"Cuiabá",wiki:"Cuiabá"},
 {uf:"MS",name:"Mato Grosso do Sul",capital:"Campo Grande",wiki:"Parque das Nações Indígenas"},
 {uf:"MG",name:"Minas Gerais",capital:"Belo Horizonte",wiki:"Igreja de São Francisco de Assis (Belo Horizonte)"},
 {uf:"PA",name:"Pará",capital:"Belém",wiki:"Estação das Docas"},
 {uf:"PB",name:"Paraíba",capital:"João Pessoa",wiki:"Farol do Cabo Branco"},
 {uf:"PR",name:"Paraná",capital:"Curitiba",wiki:"Jardim Botânico de Curitiba"},
 {uf:"PE",name:"Pernambuco",capital:"Recife",wiki:"Marco Zero"},
 {uf:"PI",name:"Piauí",capital:"Teresina",wiki:"Ponte Estaiada João Isidoro França"},
 {uf:"RJ",name:"Rio de Janeiro",capital:"Rio de Janeiro",wiki:"Pão de Açúcar"},
 {uf:"RN",name:"Rio Grande do Norte",capital:"Natal",wiki:"Forte dos Reis Magos"},
 {uf:"RS",name:"Rio Grande do Sul",capital:"Porto Alegre",wiki:"Usina do Gasômetro"},
 {uf:"RO",name:"Rondônia",capital:"Porto Velho",wiki:"Estrada de Ferro Madeira-Mamoré"},
 {uf:"RR",name:"Roraima",capital:"Boa Vista",wiki:"Orla Taumanan"},
 {uf:"SC",name:"Santa Catarina",capital:"Florianópolis",wiki:"Ponte Hercílio Luz"},
 {uf:"SE",name:"Sergipe",capital:"Aracaju",wiki:"Orla de Atalaia"},
 {uf:"SP",name:"São Paulo",capital:"São Paulo",wiki:"Ponte Estaiada Octávio Frias de Oliveira"},
 {uf:"TO",name:"Tocantins",capital:"Palmas",wiki:"Praça dos Girassóis"}
];

const SP={...ALL_UFS.find(x=>x.uf==="SP"),place:"Ponte Estaiada Octávio Frias de Oliveira",img:"https://upload.wikimedia.org/wikipedia/commons/6/62/Ponte_Oct%C3%A1vio_Frias_de_Oliveira%2C_S%C3%A3o_Paulo%2C_Brasil.jpg"};
function sampleFour(){
  const pool=ALL_UFS.filter(x=>x.uf!=="SP").slice();
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  return pool.slice(0,4);
}
const sessionStates=[SP,...sampleFour()].map(x=>({...x,status:"Em implantação"}));
let index=0,timer;
const cache=new Map();

async function wikipediaImage(item){
  if(item.img) return {img:item.img,place:item.place||item.wiki};
  if(cache.has(item.uf)) return cache.get(item.uf);
  async function request(title){
    const url="https://pt.wikipedia.org/api/rest_v1/page/summary/"+encodeURIComponent(title);
    const r=await fetch(url,{headers:{"accept":"application/json"}});
    if(!r.ok) throw new Error("not-found");
    const d=await r.json();
    return {img:(d.originalimage&&d.originalimage.source)||(d.thumbnail&&d.thumbnail.source),place:d.title||title};
  }
  try{
    const result=await request(item.wiki);
    if(!result.img) throw new Error("no-image");
    cache.set(item.uf,result); return result;
  }catch(e){
    try{
      const result=await request(item.capital);
      if(!result.img) throw new Error("no-image");
      cache.set(item.uf,result); return result;
    }catch(_){
      const result={img:"",place:item.capital};
      cache.set(item.uf,result); return result;
    }
  }
}
async function draw(){
  const s=sessionStates[index];
  document.getElementById("state-title").textContent=s.name+" / "+s.uf;
  document.getElementById("state-capital").textContent=s.capital;
  document.getElementById("state-place").textContent="Fotografia real da capital";
  document.getElementById("state-status").innerHTML='<span class="status"><span class="dot" style="background:#FFB84D"></span>'+s.status+'</span>';
  document.getElementById("carousel-count").textContent=(index+1)+" / "+sessionStates.length;
  document.getElementById("state-dots").innerHTML=sessionStates.map((_,i)=>'<span class="'+(i===index?'active':'')+'"></span>').join("");
  const photo=document.getElementById("state-photo"),loading=document.getElementById("photo-loading");
  photo.style.backgroundImage=""; loading.style.display="grid";
  const p=await wikipediaImage(s);
  if(index!==sessionStates.indexOf(s)) return;
  if(p.img) photo.style.backgroundImage='url("'+p.img+'")';
  loading.style.display=p.img?"none":"grid";
  loading.textContent=p.img?"":"Fotografia não disponível";
  document.getElementById("state-place").textContent=p.place||s.wiki||s.capital;
  document.getElementById("state-caption").textContent=(p.place||s.wiki||s.capital)+" — "+s.capital+"/"+s.uf;
}
function restart(){clearInterval(timer);timer=setInterval(next,15000)}
function next(){index=(index+1)%sessionStates.length;draw();restart()}
function prev(){index=(index-1+sessionStates.length)%sessionStates.length;draw();restart()}
document.getElementById("state-next").addEventListener("click",next);
document.getElementById("state-prev").addEventListener("click",prev);
const frame=document.querySelector(".state-frame");
frame.addEventListener("mouseenter",()=>clearInterval(timer));
frame.addEventListener("mouseleave",restart);
draw();restart();