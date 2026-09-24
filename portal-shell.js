// TriBusca — shell do app: menu mobile, busca mobile e acessibilidade do drawer.
;(()=>{
  const body=document.body;
  const navToggle=document.getElementById("nav-toggle");
  const searchToggle=document.getElementById("search-toggle");
  const backdrop=document.getElementById("nav-backdrop");
  const search=document.getElementById("global-search");
  const drawer=document.getElementById("drawer");
  const panel=drawer&&drawer.querySelector(".drawer-panel");
  const closeBtn=document.getElementById("drawer-close");
  let lastFocus=null;

  function setNav(open){
    body.classList.toggle("nav-open",open);
    navToggle.setAttribute("aria-expanded",String(open));
    navToggle.setAttribute("aria-label",open?"Fechar menu":"Abrir menu");
    if(open){const a=document.querySelector(".product-nav a.active")||document.querySelector(".product-nav a");if(a)a.focus()}
  }
  function setSearch(open){
    body.classList.toggle("search-open",open);
    searchToggle.setAttribute("aria-expanded",String(open));
    if(open)search.focus();
  }
  function closeDrawer(){drawer.classList.remove("open")}

  navToggle.addEventListener("click",()=>setNav(!body.classList.contains("nav-open")));
  backdrop.addEventListener("click",()=>setNav(false));
  searchToggle.addEventListener("click",()=>setSearch(!body.classList.contains("search-open")));
  document.querySelectorAll(".product-nav a").forEach(a=>a.addEventListener("click",()=>setNav(false)));
  search.addEventListener("keydown",e=>{if(e.key==="Enter")setSearch(false)});
  addEventListener("hashchange",()=>{setNav(false);setSearch(false)});

  // Drawer: aria-hidden sincronizado, foco no abrir, retorno do foco ao fechar.
  let wasOpen=drawer.classList.contains("open");
  new MutationObserver(()=>{
    const open=drawer.classList.contains("open");
    if(open===wasOpen)return;
    wasOpen=open;
    drawer.setAttribute("aria-hidden",String(!open));
    body.classList.toggle("drawer-open",open);
    if(open){lastFocus=document.activeElement;closeBtn.focus()}
    else if(lastFocus&&document.contains(lastFocus)){lastFocus.focus()}
  }).observe(drawer,{attributes:true,attributeFilter:["class"]});

  addEventListener("keydown",e=>{
    const drawerOpen=drawer.classList.contains("open");
    if(e.key==="Escape"){
      if(drawerOpen)closeDrawer();
      else if(body.classList.contains("nav-open")){setNav(false);navToggle.focus()}
      else if(body.classList.contains("search-open")){setSearch(false);searchToggle.focus()}
      return;
    }
    if(e.key==="Tab"&&drawerOpen){
      const f=[...panel.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x=>x.offsetParent!==null);
      if(!f.length)return;
      const first=f[0],last=f[f.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
    }
  });
})();
