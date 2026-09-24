
(function(){
  function goApp(user){ localStorage.setItem("tribuscaMockUser",JSON.stringify(user)); location.href="/app.html"; }
  const lf=document.getElementById("login-form");
  if(lf) lf.addEventListener("submit",e=>{e.preventDefault(); const email=document.getElementById("login-email").value.trim(); goApp({name:email.split("@")[0],email,company:"Empresa Demonstrativa S.A."});});
  const rf=document.getElementById("register-form");
  if(rf) rf.addEventListener("submit",e=>{e.preventDefault(); goApp({name:document.getElementById("reg-name").value.trim(),email:document.getElementById("reg-email").value.trim(),company:document.getElementById("reg-company").value.trim()});});
  const u=document.getElementById("mock-user");
  if(u){ const user=JSON.parse(localStorage.getItem("tribuscaMockUser")||'{"name":"Visitante","company":"Empresa Demonstrativa S.A."}'); u.textContent=(user.name||"Visitante")+" · "+(user.company||"Empresa Demonstrativa S.A."); }
  const lo=document.getElementById("logout");
  if(lo) lo.addEventListener("click",()=>{localStorage.removeItem("tribuscaMockUser");location.href="/login.html";});
})();