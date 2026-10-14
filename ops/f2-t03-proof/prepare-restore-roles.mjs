import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseRoles(sql) {
  const statements=[]; let t=[], i=0;
  while(i<sql.length){
    if(/\s/.test(sql[i])) {i++;continue;}
    if(sql.startsWith('--',i)){const j=sql.indexOf('\n',i);i=j<0?sql.length:j+1;continue;}
    if(sql.startsWith('/*',i)){let n=1;i+=2;while(n){if(i>=sql.length)throw Error('unterminated comment');if(sql.startsWith('/*',i)){n++;i+=2;}else if(sql.startsWith('*/',i)){n--;i+=2;}else i++;}continue;}
    if(sql[i]==='\\'){const j=sql.indexOf('\n',i);i=j<0?sql.length:j+1;continue;}
    const dollar=sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
    if(dollar){const tag=dollar[0],j=sql.indexOf(tag,i+tag.length);if(j<0)throw Error('unterminated body');t.push({v:'<body>',k:'literal'});i=j+tag.length;continue;}
    if(sql[i]==="'"||sql[i]==='"'){const q=sql[i++];let v='',closed=false;while(i<sql.length){if(sql[i]===q){if(sql[i+1]===q){v+=q;i+=2;continue;}i++;closed=true;break;}v+=sql[i++];}if(!closed)throw Error('unterminated quote');t.push({v,k:q==='"'?'id':'literal'});continue;}
    const word=sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    if(word){t.push({v:word[0].toLowerCase(),k:'word'});i+=word[0].length;continue;}
    const ch=sql[i++];if(ch===';'){if(t.length)statements.push(t);t=[];}else t.push({v:ch,k:'symbol'});
  }
  if(t.length)statements.push(t);
  const roles=new Set();
  const add=x=>{if(!x||!['word','id'].includes(x.k)||!x.v||x.v.includes('\0'))throw Error('invalid role token');if(x.k==='word'&&['public','current_user','session_user','current_role'].includes(x.v))return;roles.add(x.v);};
  const list=(a,j)=>{add(a[j++]);while(a[j]?.v===','){j++;add(a[j++]);}return j;};
  for(const a of statements){
    const w=a.map(x=>x.k==='word'?x.v.toUpperCase():null);
    if(w[0]==='ALTER'&&w.includes('OWNER')){const j=w.indexOf('OWNER');if(w[j+1]!=='TO')throw Error('invalid OWNER');add(a[j+2]);}
    if(['GRANT','REVOKE'].includes(w[0])||w.slice(0,3).join(' ')==='ALTER DEFAULT PRIVILEGES'){
      for(let j=0;j<a.length-2;j++)if(w[j]==='FOR'&&['ROLE','USER'].includes(w[j+1]))list(a,j+2);
      const marker=w.includes('REVOKE')?'FROM':'TO',j=w.indexOf(marker);if(j<0)throw Error('invalid ACL');list(a,j+1);
      for(let j=0;j<a.length-2;j++)if(w[j]==='GRANTED'&&w[j+1]==='BY')add(a[j+2]);
    }
    if(['CREATE','ALTER'].includes(w[0])&&w[1]==='POLICY'&&w.includes('TO'))list(a,w.indexOf('TO')+1);
  }
  return [...roles].sort();
}
export function renderRoles(roles) {
  return roles.filter(n=>n!=='postgres'&&!n.startsWith('pg_')&&!n.startsWith('railway')).map(n=>{
    const lit="'"+n.replaceAll("'","''")+"'",id='"'+n.replaceAll('"','""')+'"';
    const body="BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname="+lit+") THEN CREATE ROLE "+id+" NOLOGIN PASSWORD NULL; END IF; END";
    let tag='$f2role$';while(body.includes(tag))tag=tag.slice(0,-1)+'x$';
    return 'DO '+tag+body+tag+';';
  }).join('\n')+'\n';
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const roles=parseRoles(fs.readFileSync(process.argv[2],'utf8'));
  fs.writeFileSync(process.argv[3],renderRoles(roles),{mode:0o600});
  console.log('F2_T03_RESTORE_ROLE_REFERENCES='+roles.length);
}
