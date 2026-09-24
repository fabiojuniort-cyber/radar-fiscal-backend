
const states=[
  {
    name:"São Paulo",
    uf:"SP",
    capital:"São Paulo",
    status:"Disponível",
    place:"Ponte Estaiada Octávio Frias de Oliveira",
    region:"Brooklin",
    img:"https://upload.wikimedia.org/wikipedia/commons/6/62/Ponte_Oct%C3%A1vio_Frias_de_Oliveira%2C_S%C3%A3o_Paulo%2C_Brasil.jpg"
  },
  {
    name:"Paraná",
    uf:"PR",
    capital:"Curitiba",
    status:"Em implantação",
    place:"Jardim Botânico",
    region:"Curitiba/PR",
    img:"https://commons.wikimedia.org/wiki/Special:FilePath/Curitiba_jardim_botanico.jpg?width=1600"
  },
  {
    name:"Bahia",
    uf:"BA",
    capital:"Salvador",
    status:"Em implantação",
    place:"Elevador Lacerda",
    region:"Centro Histórico",
    img:"https://commons.wikimedia.org/wiki/Special:FilePath/Elevador_Lacerda_Salvador_Bahia.jpg?width=1600"
  }
];

let index=0;
let timer;

function draw(){
  const s=states[index];
  document.getElementById("state-title").textContent=s.name+" / "+s.uf;
  document.getElementById("state-capital").textContent=s.capital;
  document.getElementById("state-photo").style.backgroundImage='url("'+s.img+'")';
  document.getElementById("state-caption").textContent=s.place+" — "+s.capital+"/"+s.uf+" · "+s.region;
  document.getElementById("state-status").innerHTML=
    '<span class="status"><span class="dot" style="'+(s.status==="Disponível"?"":"background:#FFB84D")+'"></span>'+s.status+'</span>';
}
function restart(){
  clearInterval(timer);
  timer=setInterval(next,15000);
}
function next(){
  index=(index+1)%states.length;
  draw();
  restart();
}
function prev(){
  index=(index-1+states.length)%states.length;
  draw();
  restart();
}

document.getElementById("state-next").addEventListener("click",next);
document.getElementById("state-prev").addEventListener("click",prev);
const frame=document.querySelector(".state-frame");
frame.addEventListener("mouseenter",()=>clearInterval(timer));
frame.addEventListener("mouseleave",restart);
draw();
restart();
