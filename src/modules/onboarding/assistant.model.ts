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
export const phraseMapping: Record<string, string> = {
  'Agropecuária, pesca e insumos agrícolas': 'agro',
  'Veterinário e pets': 'generico',
  'Energia, petróleo, gás e combustíveis': 'combustiveis',
  'Mineração, metalurgia e produtos metálicos': 'mineracao',
  'Alimentos, bebidas e tabaco': 'alimentos',
  'Moda, têxtil, calçados e acessórios': 'textil',
  'Casa, madeira, móveis e utilidades': 'florestal',
  'Construção, materiais e engenharia': 'construcao',
  'Papel, embalagens, gráfica e editorial': 'florestal',
  'Beleza, cosméticos e bem-estar': 'generico',
  'Mídia, cultura, esporte, lazer e eventos': 'generico',
  'Tecnologia, eletrônicos e telecomunicações': 'tecnologia',
  'Química, borracha e plásticos': 'quimicos',
  'Saúde, farmacêutico e assistência': 'farmaceutico',
  'Automotivo e equipamentos de transporte': 'automotivo',
  'Indústria, máquinas e equipamentos': 'maquinas',
  'Segurança, vigilância e proteção': 'generico',
  'Água, saneamento, resíduos e reciclagem': 'generico',
  'Marketing, publicidade e design': 'generico',
  'Imobiliário': 'generico',
  'Comércio multissetorial, holdings e atividades transversais': 'generico',
  'Transporte e logística': 'transporte',
  'Turismo e hospedagem': 'generico',
  'Restaurantes e serviços de alimentação': 'alimentos',
  'Consultoria, pesquisa e serviços técnicos': 'generico',
  'Finanças, seguros e previdência': 'generico',
  'Jurídico, contabilidade e auditoria': 'generico',
  'RH, facilities e apoio empresarial': 'generico',
  'Locação, licenciamento e gestão de ativos': 'generico',
  'Administração pública e instituições': 'generico',
  'Educação e treinamento': 'generico',
  'Serviços pessoais, domésticos e funerários': 'generico',
};
export function phraseSegment(parent: string): string { return phraseMapping[parent] ?? 'generico'; }
