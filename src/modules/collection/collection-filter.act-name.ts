/** The single title -> Nome do ato implementation. Official type is metadata only. */
export function collectionFilterActName(title: string): string {
  const line=(title.split(/[\r\n]/,1)[0]??'').trim();
  const cut=line.search(/\s+N(?:[º°]|[oO]\.?|[úu]mero|\.)?\s*(?:\d|$)|\s+\d+(?=[\s/.,-]|$)|,\s*DE\b|\s+DE\s+(?=\d{1,2}(?:[\/.\s]|$))|\s+[-–—]\s+|\s*\(/iu);
  const prefix=(cut<0?line:line.slice(0,cut))
    // A trailing agency/UF identifier is not part of the name (e.g. PGE-SP).
    .replace(/\s+[A-Z]{2,12}-[A-Z]{2}\s*$/iu,'')
    .replace(/[\s,;:–-]+$/g,'').replace(/[-–—]+/g,' ')
    .replace(/\s+/g,' ').trim();
  const particles=new Set(['a','as','o','os','ao','aos','à','às','da','de','do','das','dos','e','em','na','no','nas','nos']);
  return prefix.toLocaleLowerCase('pt-BR').split(' ').map((word,index)=>
    index>0&&particles.has(word)?word:word.replace(/^\p{L}/u,c=>c.toLocaleUpperCase('pt-BR'))
  ).join(' ');
}
