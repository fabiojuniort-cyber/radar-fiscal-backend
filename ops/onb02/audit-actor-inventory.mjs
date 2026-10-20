const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys=new Set(['actor','actorId','actor_id','userId','createdByActor','created_by_actor',
  'actorRef','actor_ref','reviewerActorId','decisionActorId']);
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function actorViolations(path,text,registry) {
  const errors=[],seen=new Set(),allowed=new Set(registry.systemActors);
  function check(value,position,kind) {
    if(uuid.test(value))return;
    const nonAudit=registry.nonAuditReferences.some(item=>item.value===value&&item.paths.includes(path));
    if(allowed.has(value)||nonAudit)return;
    // Runtime values remain guarded by the DB. Operator UUID placeholders are not static actors.
    if(/^(?:<[^>]+>|\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\})$/.test(value))return;
    const key=position+':'+kind;if(seen.has(key))return;seen.add(key);
    errors.push({path,line:text.slice(0,position).split('\n').length,kind});
  }
  // Documentation, JSON, YAML and shell declarations as well as TS object literals.
  for(const match of text.matchAll(/(?:\b(?:actor|actorId|actor_id|userId|createdByActor|actorRef|actor_ref)\b|["'](?:actor|actor_id|userId|actorRef|actor_ref)["'])\s*[:=]\s*(["'`])([^"'\`\r\n]+)\1/g))
    check(match[2],match.index,'literal_actor');
  for(const match of text.matchAll(/\b[A-Z_]*(?:ACTOR|ACTOR_ID|ACTOR_REF)\s*[:=]\s*["']?([A-Za-z0-9_:.$<>\{\}-]+)/g))
    check(match[1],match.index,'environment_actor');
  for(const match of text.matchAll(/--(?:actor|actor-id|actor_id|actor-ref|actor_ref)(?:=|\s+)["']?([A-Za-z0-9_:.$<>\{\}-]+)/g))
    check(match[1],match.index,'command_actor');
  for(const match of text.matchAll(/\bsystem:[a-z0-9][a-z0-9.-]*/g))
    check(match[0],match.index,'system_identity');
  for(const writer of registry.writers)for(const legacy of writer.previousIds) {
    const pattern=new RegExp("(['\"`])"+escape(legacy)+"\\1",'g');
    for(const match of text.matchAll(pattern))check(legacy,match.index,'legacy_actor');
  }
  function sqlActors(sql,position) {
    for(const match of sql.matchAll(/INSERT\s+INTO\s+(?:public\.)?audit_log\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]*?)\)/gi)) {
      const columns=match[1].split(',').map(value=>value.trim().replaceAll('"',''));
      const index=columns.indexOf('actor_id');if(index<0)continue;
      // actor_id is before JSON/function arguments in all current raw writers.
      const values=match[2].split(/,(?=(?:[^']*'[^']*')*[^']*$)/);
      const value=values[index]?.trim().match(/^'([^']*)'(?:\s*::\s*text)?$/i);
      if(value)check(value[1],position+match.index,'sql_actor');
    }
  }
  sqlActors(text,0);
  // Resolve static JS/TS string bindings and SQL array.join adapters without executing source.
  const stringPattern=/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
  function decode(literal) {
    return literal.slice(1,-1).replace(/\\(?:u([a-f0-9]{4})|x([a-f0-9]{2})|([\\'"nrttbfv`]))/gi,
      (_,unicode,hex,char)=>unicode||hex ? String.fromCharCode(parseInt(unicode||hex,16)) :
        ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v'}[char]??char));
  }
  const bindings=new Map();
  for(const match of text.matchAll(/\b(?:const|let)\s+(\w+)(?:\s*:[^=\n]+)?\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g))
    bindings.set(match[1],decode(match[2]));
  for(const match of text.matchAll(/\b(actor|actorId|actor_id|userId|actorRef|actor_ref)\s*:\s*(\w+)\b/g))
    if(bindings.has(match[2]))check(bindings.get(match[2]),match.index,'bound_actor');
  for(const match of text.matchAll(/\b(?:actor|actorId|actor_id|userId|actorRef|actor_ref)\s*:[^\n;]{0,160}?(?:\?\?|\|\|)\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g))
    check(decode(match[1]),match.index,'fallback_actor');
  for(const match of text.matchAll(/\b(?:const|let)\s+([A-Za-z_]*[Aa][Cc][Tt][Oo][Rr][A-Za-z_]*)(?:\s*:[^=\n]+)?\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g))
    check(decode(match[2]),match.index,'actor_binding');
  for(const match of text.matchAll(stringPattern))sqlActors(decode(match[0]),match.index);
  for(const match of text.matchAll(/\[\s*((?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,?\s*)+)\]\s*\.join\s*\(/g)) {
    const parts=[...match[1].matchAll(stringPattern)].map(value=>decode(value[0]));
    sqlActors(parts.join('\n'),match.index);
  }
  // A parameterized SQL template may bind a constant rather than spelling the actor inline.
  const resolved=text.replace(/\$\{(\w+)\}/g,(whole,key)=>bindings.has(key) ?
    "'"+bindings.get(key).replaceAll("'","''")+"'" : whole);
  sqlActors(resolved,0);
  return errors;
}
