export const dimensionGroups = [
 {code:'tax_regime',title:'Tributos e regime',dimensions:['tax','regime']},
 {code:'operations_documents',title:'Operações e documentos',dimensions:['operation','operation_purpose','document']},
 {code:'obligations_context',title:'Obrigações e contexto',dimensions:['obligation','actuacao','subject','theme']},
];
/** Legacy individual-card reviews remain readable; no migration or GET write. */
export function dimensionGroupReviewed(cards:Record<string,unknown>,group:typeof dimensionGroups[number],available:string[]){
 return !!cards['dimension-group:'+group.code]||group.dimensions.filter(code=>available.includes(code)).every(code=>!!cards['dimension:'+code]);
}
