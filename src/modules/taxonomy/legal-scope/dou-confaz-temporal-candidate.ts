/**
 * Trifaros TAX13-R8-02: legislation chronology is NOT legal CURRENT.
 *
 * This pure validator relates public act / ratification / effect / deadline
 * dates. It cannot verify authenticity of a document, amendments, cessation,
 * current legal effect or actual taxpayer eligibility. No DB write or green.
 */
type Rejected={
 readonly status:'UNVERIFIED';
 readonly grantsLegalCurrent:false;
 readonly reason:string;
};
export type DouConfazTemporalCandidate=Rejected|{
 readonly status:'DOU_RATIFICATION_TEMPORAL_FACTS_ONLY';
 readonly grantsLegalCurrent:false;
 readonly amendmentsAndRevocationReview:'NOT_PERFORMED';
 readonly originalPublishedOn:string;
 readonly ratificationPublishedOn:string;
 readonly declaredEffectsFrom:string;
 readonly exceptionalDeadline:string|null;
 readonly referenceDate:string;
 readonly ratificationAfterExceptionalDeadline:boolean|null;
 readonly exceptionalDeadlineBeforeReferenceDate:boolean|null;
 readonly operationalEffectInReferencePeriod:'NOT_ASSESSED';
 readonly sourceActUrl:string;
 readonly ratificationActUrl:string;
 readonly actReference:string;
};
const fail=(reason:string):Rejected=>({status:'UNVERIFIED',grantsLegalCurrent:false,reason});
function checkedIsoDate(value:string):boolean{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const n=Date.parse(value+'T00:00:00Z');
 return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===value;
}
function source(url:string,part:'convenios'|'atos-declaratorios',year:string):boolean{
 try{
  const u=new URL(url);
  return u.protocol==='https:'&&u.hostname==='www.confaz.fazenda.gov.br'&&
   !u.username&&!u.password&&!u.port&&!u.hash&&!u.search&&
   u.pathname.startsWith('/legislacao/'+part+'/'+year+'/')&&
   !u.pathname.includes('/../');
 }catch{return false;}
}
export function assessDouConfazTemporalCandidate(input:{
 actReference:string;
 originalActOfficialUrl:string;
 originalPublishedOn:string;
 ratificationActOfficialUrl:string;
 ratificationReferences:readonly string[];
 ratificationPublishedOn:string;
 declaredEffectsFrom:string;
 exceptionalDeadline?:string|null;
 referenceDate:string;
}):DouConfazTemporalCandidate{
 if(!input||!/^CONVENIO_ICMS:[1-9]\d{0,2}:20\d{2}$/.test(input.actReference)||
  !Array.isArray(input.ratificationReferences)||
  !input.ratificationReferences.includes(input.actReference))
  return fail('DOU_RATIFICATION_IDENTITY_NOT_CORRELATED');
 const [,number,year]=input.actReference.split(':');
 const expectedActPath='/legislacao/convenios/'+year+'/CV'+number!.padStart(3,'0')+'_'+year!.slice(2);
 if(!source(input.originalActOfficialUrl,'convenios',year!)||
  new URL(input.originalActOfficialUrl).pathname.toUpperCase()!==expectedActPath.toUpperCase()||
  !source(input.ratificationActOfficialUrl,'atos-declaratorios',year!))
  return fail('DOU_RATIFICATION_OFFICIAL_REFERENCE_INVALID');
 for(const date of [input.originalPublishedOn,input.ratificationPublishedOn,
  input.declaredEffectsFrom,input.referenceDate,input.exceptionalDeadline].filter(
   (x):x is string=>typeof x==='string')){
  if(!checkedIsoDate(date))return fail('DOU_RATIFICATION_DATE_INVALID');
 }
 const {originalPublishedOn,ratificationPublishedOn,declaredEffectsFrom,referenceDate}=input;
 if(originalPublishedOn>ratificationPublishedOn||declaredEffectsFrom>ratificationPublishedOn)
  return fail('DOU_RATIFICATION_CHRONOLOGY_CONFLICT');
 const deadline=input.exceptionalDeadline??null;
 return {
  status:'DOU_RATIFICATION_TEMPORAL_FACTS_ONLY',grantsLegalCurrent:false,
  amendmentsAndRevocationReview:'NOT_PERFORMED',
  originalPublishedOn,ratificationPublishedOn,declaredEffectsFrom,
  exceptionalDeadline:deadline,referenceDate,
  ratificationAfterExceptionalDeadline:deadline===null?null:ratificationPublishedOn>deadline,
  exceptionalDeadlineBeforeReferenceDate:deadline===null?null:referenceDate>deadline,
  operationalEffectInReferencePeriod:'NOT_ASSESSED',
  sourceActUrl:input.originalActOfficialUrl,
  ratificationActUrl:input.ratificationActOfficialUrl,
  actReference:input.actReference,
 };
}
