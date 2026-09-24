
const http=require("http");
const fs=require("fs");
const path=require("path");
const port=Number(process.env.PORT||3000);
const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".webp":"image/webp"};
http.createServer((req,res)=>{
  let pathname=req.url.split("?")[0];
  if(pathname==="/") pathname="/index.html";
  const file=path.join(process.cwd(),pathname.replace(/^\//,""));
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);res.end("Not found");return;}
    res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"public, max-age=300"});
    res.end(data);
  });
}).listen(port,"0.0.0.0",()=>console.log("TriBusca prototype listening on",port));
