import {isCnaeActivity} from '../taxonomy/curation/curation.constants.js';
export type CardSelection = { status: 'CONFIRMED' | 'SKIPPED'; conceptCodes: string[]; ncmCodes: string[] };
export type AssistantUnit = { baseConceptCodes: string[]; baseNcmCodes: string[]; cards: Record<string, CardSelection> };
export type AssistantState = { schemaVersion: 1; releaseId?: string; cards: Record<string, CardSelection>; units: Record<string, AssistantUnit>; completed: boolean };
export const emptyAssistant = (): AssistantState => ({ schemaVersion: 1, cards: {}, units: {}, completed: false });
export function mergeUnitCard(unit: AssistantUnit, cardId: string, selection: CardSelection) {
  const next = { ...unit, cards: { ...unit.cards, [cardId]: selection } };
  const confirmed = Object.values(next.cards).filter(card => card.status === 'CONFIRMED');
  return { unit: next,
    conceptCodes: [...new Set([...unit.baseConceptCodes, ...confirmed.flatMap(card => card.conceptCodes)])].sort(),
    ncmCodes: [...new Set([...unit.baseNcmCodes, ...confirmed.flatMap(card => card.ncmCodes)])].sort() };
}
/** Explicit F2 parent labels. Unknown/future segments always use generico. */
export const phraseMapping: Record<string, string[]> = {
  'Agropecuária, pesca e insumos agrícolas': ['agro', 'pecuaria'],
  'Veterinário e pets': ['generico'],
  'Energia, petróleo, gás e combustíveis': ['energia', 'combustiveis'],
  'Mineração, metalurgia e produtos metálicos': ['mineracao', 'metalurgia'],
  'Alimentos, bebidas e tabaco': ['alimentos'],
  'Moda, têxtil, calçados e acessórios': ['textil'],
  'Casa, madeira, móveis e utilidades': ['florestal'],
  'Construção, materiais e engenharia': ['construcao'],
  'Papel, embalagens, gráfica e editorial': ['florestal'],
  'Beleza, cosméticos e bem-estar': ['generico'],
  'Mídia, cultura, esporte, lazer e eventos': ['generico'],
  'Tecnologia, eletrônicos e telecomunicações': ['tecnologia'],
  'Química, borracha e plásticos': ['quimicos'],
  'Saúde, farmacêutico e assistência': ['farmaceutico'],
  'Automotivo e equipamentos de transporte': ['automotivo'],
  'Indústria, máquinas e equipamentos': ['maquinas'],
  'Segurança, vigilância e proteção': ['generico'],
  'Água, saneamento, resíduos e reciclagem': ['generico'],
  'Marketing, publicidade e design': ['generico'],
  'Imobiliário': ['generico'],
  'Comércio multissetorial, holdings e atividades transversais': ['atacado', 'varejo'],
  'Transporte e logística': ['transporte'],
  'Turismo e hospedagem': ['generico'],
  'Restaurantes e serviços de alimentação': ['alimentos'],
  'Consultoria, pesquisa e serviços técnicos': ['generico'],
  'Finanças, seguros e previdência': ['generico'],
  'Jurídico, contabilidade e auditoria': ['generico'],
  'RH, facilities e apoio empresarial': ['generico'],
  'Locação, licenciamento e gestão de ativos': ['generico'],
  'Administração pública e instituições': ['generico'],
  'Educação e treinamento': ['generico'],
  'Serviços pessoais, domésticos e funerários': ['generico'],
};
export function phraseSegments(parent: string): string[] { return phraseMapping[parent] ?? ['generico']; }
export function phraseSegment(parent: string): string { return phraseSegments(parent)[0] ?? 'generico'; }

export function selectableAssistantConcept(c:{dimensionCode:string;officialCodes:string[]}):boolean {
  return c.dimensionCode==='product'||(c.dimensionCode==='sector'&&!isCnaeActivity(c.officialCodes));
}

/** Conversion occurs only during an explicit save, never GET or migration. */
export function upgradeLegacyUnit(unit:AssistantUnit,activities:{cnaeCode:string;segmentCode:string;suggestions:{target:string}[]}[]):AssistantUnit{
 const next=structuredClone(unit);
 for(const [key,choice] of Object.entries(unit.cards)){
  if(!key.startsWith('cnae:'))continue;
  const related=activities.filter(a=>a.cnaeCode===key.slice(5));
  if(!related.length)continue;
  const known=new Set(related.flatMap(a=>a.suggestions.map(s=>s.target)));
  if(choice.status==='CONFIRMED'){
   next.baseConceptCodes=[...new Set([...next.baseConceptCodes,...choice.conceptCodes.filter(c=>!known.has(c))])];
   next.baseNcmCodes=[...new Set([...next.baseNcmCodes,...choice.ncmCodes.filter(c=>!known.has(c))])];
  }
  for(const activity of related){
   const id='segment:'+activity.segmentCode,prior=next.cards[id];
   const targets=new Set(activity.suggestions.map(s=>s.target));
   next.cards[id]={status:prior?.status==='CONFIRMED'||choice.status==='CONFIRMED'?'CONFIRMED':'SKIPPED',
    conceptCodes:[...new Set([...(prior?.conceptCodes??[]),...(choice.status==='CONFIRMED'?choice.conceptCodes.filter(c=>targets.has(c)):[])])],
    ncmCodes:[...new Set([...(prior?.ncmCodes??[]),...(choice.status==='CONFIRMED'?choice.ncmCodes.filter(c=>targets.has(c)):[])])]};
  }
  delete next.cards[key];
 }
 return next;
}
