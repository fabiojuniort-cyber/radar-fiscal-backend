/**
 * ORACLE ONLY — the rules that were hard-coded in the reader and the entity extractor before P1.B, copied verbatim
 * from `src/modules/anatomy/readers.ts` and `entities.ts` at P1.A HEAD 585f5a4937437219e43c68e1372fe7f5c68ac1dd
 * (`git show 585f5a49:src/modules/anatomy/readers.ts`). Tests compare the compiled default profile against them.
 * Never imported by product code.
 */
export const LEGACY = Object.freeze({
  historical: /^(?:RedaoAnt|RemissoAnt|A8-2RemissaoAnt|A8-3RedacaoAnt)$/,
  notes: /^(?:DataPublicao|A2DataPublicacao|Remisso|RemissoAnt|A8-1Remissao|A8-2RemissaoAnt)$/,
  body: /^(?:TextoAcordo|A5-1TextoAcordo|RedaoAnt|A8-3RedacaoAnt)$/,
  confazEpigraph: ['TituloAcordo'], confazSummary: ['Ementa'],
  douEpigraph: ['identifica'], douSummary: ['ementa'], douSignature: ['assina', 'cargo'],
  rectificationOriginal: /^Onde\s+se\s+l[êe](?![\p{L}\p{N}])/iu,
  rectificationCorrected: /^Leia-se(?![\p{L}\p{N}])/iu,
  quoteBlockOpen: /^\s*["“]/u,
  preamble: /^(?:O\s+(?:Conselho|Ministro|Secret[áa]rio|Governador|Presidente)|A\s+(?:Secret[áa]ria|Receita Federal)|CONSIDERANDO\b)/iu,
  annex: /^ANEXO\s+(?:[IVXLCDM]+|[0-9]+)(?:\s*[-–—:(]|\s*$)/iu,
  clause: /^Cl[áa]usula\s+(?:primeira|segunda|terceira|quarta|quinta|sexta|s[ée]tima|oitava|nona|d[ée]cima|\d+)/iu,
  article: /^(?:Art(?:igo|\.)\s*\d+[ºo°]?)/iu,
  paragraph: /^(?:§\s*\d+|Par[áa]grafo\s+[úu]nico)/iu,
  quoteOpen: /^[“"]/u,
  quoteClose: /[”"](?:\s*\(NR\)\.?)?\s*$/u,
  quoteOnly: /^[“"]$/,
  ncmHeader: /^(?:C[ÓO]DIGO\s+)?NCM(?:\s*\/\s*SH)?$/iu,
  ncmBlocker: /^(?:NBM|TIPI|SH|C[ÓO]DIGO)(?:\s*\/.*)?$/iu,
  ncmMarker: /\bNCM(?:\/SH)?\b\s*(?:(?:c[oó]digos?|n[.º°o]s?)\s*)?[:=-]?\s*/giu,
  codeList: /^(?:[ \t]*(?:\d[\d.]*|at[eé](?!\p{L})|a\b|e\b|ou\b|exceto\b|excetuad[oa]s?\b|exclu[ií]d[oa]s?\b|salvo\b|exclusive\b|inclusive\b|de\b|[,:;()–—-]))+/iu,
  rangeBridge: /^\s*(?:a|at[eé]|[-–—])\s*$/iu,
  exceptionMarker: /\b(?:exceto|excetuad[oa]s?|exclu[ií]d[oa]s?|salvo|exclusive)\b/giu,
});
