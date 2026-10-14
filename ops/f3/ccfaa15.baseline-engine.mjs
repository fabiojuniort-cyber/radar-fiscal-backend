                                  
                 
                      
                           
                     

                                          
            
          
               

                                      
           
             
           

                                           
                     
                   
                        
                             
 

                                            
                     
                   
                
                        
 

                                       
               
                                         
                      
                   
                         
                                                   
 

                                              
                  
                             
                             
                    
                  
                    
                 
    
                                             
                                                 
                                         
 

                                              
                     
                          
                          
                
                          
                       
                            
                                          
                         
                                                                                     
                                            
                               
 

                                          
               
                                         
                                     
                     
                 
                                 
 

                                           
                        
                               
             
                    
                           
                           
                     
                                   
                           
                   
                   
                           
                   
                      
                       
                     
                  
                  
                            
                         
                              
                                 
                    
                                      
 

                        
                                 
                     
                   
                      
                   
                         
                                                  
 

                                                 
                  
                             
                             
                                                            
                                                       
                                       
                                 
 

const NON_PRESERVING_POSITIVE_TERMS = new Set([
  'cnpj',
  'cpf',
  'processo',
  'processo administrativo',
  'numero do processo',
  'valor',
  'valor total',
  'valor global',
]);

export function normalizeCollectionFilterText(value        )         {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('pt-BR')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeCollectionFilterType(value        )         {
  return normalizeCollectionFilterText(value);
}

/**
 * Source-provided DOU type is often a generic family (e.g. "Resolução")
 * while the canonical parser emits a specific act type. Treat a proper
 * normalized prefix as compatible, never an unrelated classification.
 * The final KEEP/DISCARD decision remains in evaluateCollectionFilter.
 */
export function collectionFilterTypeConflict(sourceActType                           ,
  canonicalActType                           )          {
  const source = normalizeCollectionFilterType(sourceActType ?? '');
  if (!source) return false;
  const canonical = normalizeCollectionFilterType(canonicalActType ?? '');
  return source !== canonical && !canonical.startsWith(source + ' ');
}

function normalizedSection(value                           )         {
  return normalizeCollectionFilterText(value ?? '');
}

function normalizedSource(value        )         {
  return normalizeCollectionFilterText(value);
}

function key(source        , section        , type        )         {
  return `${source}\u0000${section}\u0000${type}`;
}

function validatePositiveInteger(value        , name        )       {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError(`${name} must be an integer between 1 and 100`);
  }
}

export function compileCollectionFilterPolicy(
  input                             ,
)                                 {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new RangeError('policy version must be a positive integer');
  }
  if (
    !Number.isSafeInteger(input.contextWindowWords) ||
    input.contextWindowWords < 0 ||
    input.contextWindowWords > 100
  ) {
    throw new RangeError('contextWindowWords must be between 0 and 100');
  }
  validatePositiveInteger(
    input.weakScoreThreshold,
    'weakScoreThreshold',
  );
  validatePositiveInteger(input.locationWeights.title, 'titleWeight');
  validatePositiveInteger(
    input.locationWeights.summary,
    'summaryWeight',
  );
  validatePositiveInteger(input.locationWeights.body, 'bodyWeight');

  const rules = new Map                                  ();
  for (const rule of input.rules) {
    const sourceCode = normalizedSource(rule.sourceCode);
    const section = normalizedSection(rule.section);
    const canonicalType = normalizeCollectionFilterType(
      rule.canonicalType,
    );
    if (!sourceCode || !canonicalType) {
      throw new Error('filter rule source/type must not be blank');
    }
    const ruleKey = key(sourceCode, section, canonicalType);
    if (rules.has(ruleKey)) {
      throw new Error(`duplicate filter rule: ${ruleKey}`);
    }
    rules.set(ruleKey, {
      ...rule,
      sourceCode,
      section,
      canonicalType,
    });
  }

  const aliases = new Map                ();
  for (const alias of input.aliases ?? []) {
    const sourceCode = normalizedSource(alias.sourceCode);
    const section = normalizedSection(alias.section);
    const normalizedAlias = normalizeCollectionFilterType(alias.alias);
    const canonicalType = normalizeCollectionFilterType(
      alias.canonicalType,
    );
    if (!sourceCode || !normalizedAlias || !canonicalType) {
      throw new Error('filter alias fields must not be blank');
    }
    const aliasKey = key(sourceCode, section, normalizedAlias);
    const existing = aliases.get(aliasKey);
    if (existing && existing !== canonicalType) {
      throw new Error(`conflicting filter alias: ${aliasKey}`);
    }
    aliases.set(aliasKey, canonicalType);
  }

  const terms                 = input.terms.map((term) => {
    const normalized = normalizeCollectionFilterText(term.text);
    if (!normalized) throw new Error('filter term must not be blank');
    const normalizedLower = normalized.toLocaleLowerCase('pt-BR');
    if (
      term.strength !== 'NEGATIVE' &&
      NON_PRESERVING_POSITIVE_TERMS.has(normalizedLower)
    ) {
      throw new Error(
        `term cannot preserve a publication by itself: ${term.text}`,
      );
    }
    return {
      original: term,
      normalized,
      tokens: normalized.split(' '),
      ...(term.sourceCode
        ? { sourceCode: normalizedSource(term.sourceCode) }
        : {}),
      ...(term.section !== undefined
        ? { section: normalizedSection(term.section) }
        : {}),
      ...(term.canonicalType
        ? {
            canonicalType: normalizeCollectionFilterType(
              term.canonicalType,
            ),
          }
        : {}),
      locationScope: term.locationScope ?? 'ANY',
    };
  });

  const termScopes = new Map                                      ();
  for (const term of terms) {
    const scopeKey = [
      term.normalized,
      term.sourceCode ?? '',
      term.section ?? '',
      term.canonicalType ?? '',
      term.locationScope,
    ].join('\u0000');
    const existing = termScopes.get(scopeKey);
    if (existing) {
      if (existing === term.original.strength) {
        throw new Error(`duplicate filter term: ${term.normalized}`);
      }
      throw new Error(
        `conflicting filter term strength: ${term.normalized}`,
      );
    }
    termScopes.set(scopeKey, term.original.strength);
  }

  return {
    version: input.version,
    contextWindowWords: input.contextWindowWords,
    weakScoreThreshold: input.weakScoreThreshold,
    locationWeights: {
      TITLE: input.locationWeights.title,
      SUMMARY: input.locationWeights.summary,
      BODY: input.locationWeights.body,
    },
    rules,
    aliases,
    terms,
  };
}

                             
                                     
                   
 

function tokenize(value                           )           {
  const normalized = normalizeCollectionFilterText(value ?? '');
  return normalized ? normalized.split(' ') : [];
}

function termMatchesAt(
  tokens                   ,
  term                   ,
  index        ,
)          {
  if (index + term.length > tokens.length) return false;
  for (let offset = 0; offset < term.length; offset += 1) {
    if (tokens[index + offset] !== term[offset]) return false;
  }
  return true;
}

function scoped(
  term              ,
  sourceCode        ,
  section        ,
  canonicalType        ,
  location                          ,
)          {
  return (
    (!term.sourceCode || term.sourceCode === sourceCode) &&
    (term.section === undefined || term.section === section) &&
    (!term.canonicalType || term.canonicalType === canonicalType) &&
    (term.locationScope === 'ANY' ||
      term.locationScope === location)
  );
}

function distance(
  leftIndex        ,
  leftLength        ,
  rightIndex        ,
  rightLength        ,
)         {
  const leftEnd = leftIndex + leftLength - 1;
  const rightEnd = rightIndex + rightLength - 1;
  if (leftEnd < rightIndex) return rightIndex - leftEnd;
  if (rightEnd < leftIndex) return leftIndex - rightEnd;
  return 0;
}

export function evaluateCollectionFilter(
  policy                                ,
  publication                             ,
)                           {
  const sourceCode = normalizedSource(publication.sourceCode);
  const section = normalizedSection(publication.section);
  const rawType = publication.actType?.trim() ?? '';
  const normalizedRawType = normalizeCollectionFilterType(rawType);

  const base = {
    policyVersion: policy.version,
    sourceCode,
    section,
    rawType,
    normalizedRawType,
    requiresNewTypeReview: false,
    weakScore: 0,
    termHits: []                             ,
  };

  if (!normalizedRawType) {
    return {
      ...base,
      decision: 'KEEP',
      reasonCode: 'UNKNOWN_TYPE',
      requiresNewTypeReview: true,
    };
  }

  const canonicalType =
    policy.aliases.get(key(sourceCode, section, normalizedRawType)) ??
    normalizedRawType;
  const rule =
    policy.rules.get(key(sourceCode, section, canonicalType));

  if (!rule) {
    return {
      ...base,
      canonicalType,
      decision: 'KEEP',
      reasonCode: 'UNKNOWN_TYPE',
      requiresNewTypeReview: true,
    };
  }

  const safeBase = {
    ...base,
    canonicalType,
    mode: rule.mode,
  };

  if (!publication.evidenceComplete) {
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'INCOMPLETE_EVIDENCE',
    };
  }
  if (publication.materialAttachmentsUnexamined) {
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'UNEXAMINED_MATERIAL',
    };
  }
  if (publication.typeConflict) {
    // Only relax the fail-open rule when BOTH disagreeing types independently
    // resolve to EXCLUDE_ALWAYS for this exact source and section. All other
    // conflicts remain KEEP, including unknown/missing source types.
    const sourceType = normalizeCollectionFilterType(publication.sourceActType ?? '');
    const sourceCanonical = policy.aliases.get(key(sourceCode, section, sourceType)) ?? sourceType;
    const sourceRule = sourceType ? policy.rules.get(key(sourceCode, section, sourceCanonical)) : undefined;
    if (rule.mode === 'EXCLUDE_ALWAYS' &&
        sourceRule?.mode === 'EXCLUDE_ALWAYS' &&
        !publication.provenanceConflict) {
      return {
        ...safeBase,
        decision: 'DISCARD',
        reasonCode: 'TYPE_CONFLICT_BOTH_EXCLUDED',
      };
    }
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'TYPE_CONFLICT',
    };
  }
  if (publication.provenanceConflict) {
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'PROVENANCE_CONFLICT',
    };
  }
  if (rule.mode === 'KEEP_ALWAYS') {
    return {
      ...safeBase,
      decision: 'KEEP',
      reasonCode: 'KEEP_ALWAYS',
    };
  }

  const locations                      = [
    { location: 'TITLE', tokens: tokenize(publication.title) },
    { location: 'SUMMARY', tokens: tokenize(publication.summary) },
    { location: 'BODY', tokens: tokenize(publication.body) },
  ];

                 
                       
                                       
                       
    
  const rawHits           = [];
  for (const location of locations) {
    for (const term of policy.terms) {
      if (
        !scoped(
          term,
          sourceCode,
          section,
          canonicalType,
          location.location,
        )
      ) {
        continue;
      }
      for (
        let index = 0;
        index <= location.tokens.length - term.tokens.length;
        index += 1
      ) {
        if (termMatchesAt(location.tokens, term.tokens, index)) {
          rawHits.push({
            term,
            location: location.location,
            tokenIndex: index,
          });
        }
      }
    }
  }

  const negativeHits = rawHits.filter(
    (hit) => hit.term.original.strength === 'NEGATIVE',
  );
  let weakScore = 0;
  let strong = false;
  const termHits                            = rawHits.map((hit) => {
    const strength = hit.term.original.strength;
    const weight = policy.locationWeights[hit.location];
    let neutralizedByNegative = false;
    if (strength === 'STRONG') {
      strong = true;
    } else if (strength === 'WEAK') {
      neutralizedByNegative = negativeHits.some(
        (negative) =>
          negative.location === hit.location &&
          distance(
            hit.tokenIndex,
            hit.term.tokens.length,
            negative.tokenIndex,
            negative.term.tokens.length,
          ) <= policy.contextWindowWords,
      );
      if (!neutralizedByNegative) weakScore += weight;
    }
    return {
      text: hit.term.original.text,
      strength,
      location: hit.location,
      tokenIndex: hit.tokenIndex,
      weight,
      neutralizedByNegative,
    };
  });

  const evaluatedBase = {
    ...safeBase,
    weakScore,
    termHits,
  };

  if (rule.mode === 'EXCLUDE_ALWAYS') {
    return {
      ...evaluatedBase,
      decision: 'DISCARD',
      reasonCode: 'EXCLUDE_ALWAYS',
    };
  }

  if (strong) {
    return {
      ...evaluatedBase,
      decision: 'KEEP',
      reasonCode: 'STRONG_TERM',
    };
  }

  if (rule.mode === 'EXCLUDE_UNLESS_STRONG') {
    return {
      ...evaluatedBase,
      decision: 'DISCARD',
      reasonCode: 'NO_STRONG_TERM',
    };
  }

  if (weakScore >= policy.weakScoreThreshold) {
    return {
      ...evaluatedBase,
      decision: 'KEEP',
      reasonCode: 'WEAK_TERM_THRESHOLD',
    };
  }

  return {
    ...evaluatedBase,
    decision: 'DISCARD',
    reasonCode: 'NO_TAX_TERM',
  };
}
