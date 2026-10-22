import type {DirectRuleInput} from './collection-filter.direct.js';

/**
 * Ephemeral server-side proof that an authenticated admin actually requested
 * this exact non-destructive classification preview.
 * This is NOT a purge capability; confirm always executes its own full scan.
 * On another instance, restart or expiration, save falls back to full F3 validation.
 */
export interface DirectPreviewWitness {
  userId:string;
  requested:DirectRuleInput;
  rule:DirectRuleInput;
  count:number;
  token:string;
  confirmationToken:string;
  policyRevision:number;
  archiveStamp:string;
  issuedAt:number;
}

export const DIRECT_PREVIEW_TTL_MS=90_000;
const MAX_WITNESSES=64;
const witnesses=new WeakMap<object,DirectPreviewWitness[]>();

function identity(rule:DirectRuleInput):string {
  return JSON.stringify([
    rule.sourceCode.trim().toLowerCase(),
    rule.section.trim().toUpperCase(),
    rule.canonicalType.trim().toLocaleUpperCase('pt-BR'),
    rule.mode,
    rule.newTypeId??null,
  ]);
}

export function rememberDirectPreview(
  db:object,witness:DirectPreviewWitness,now=Date.now(),
):void {
  const recent=(witnesses.get(db)??[])
    .filter(w=>now-w.issuedAt>=0&&now-w.issuedAt<=DIRECT_PREVIEW_TTL_MS&&
      !(w.userId===witness.userId&&identity(w.requested)===identity(witness.requested)));
  recent.push({...witness,requested:{...witness.requested},rule:{...witness.rule}});
  witnesses.set(db,recent.slice(-MAX_WITNESSES));
}

export function findDirectPreview(
  db:object,userId:string,input:DirectRuleInput,
  count:number,token:string,policyRevision:number,confirmationToken:string,
  now=Date.now(),
):DirectPreviewWitness|undefined {
  const recent=(witnesses.get(db)??[])
    .filter(w=>now-w.issuedAt>=0&&now-w.issuedAt<=DIRECT_PREVIEW_TTL_MS);
  witnesses.set(db,recent);
  return recent.findLast(w=>w.userId===userId&&
    identity(w.requested)===identity(input)&&
    w.count===count&&w.token===token&&
    w.policyRevision===policyRevision&&w.confirmationToken===confirmationToken);
}

export function forgetDirectPreview(db:object,witness:DirectPreviewWitness):void {
  witnesses.set(db,(witnesses.get(db)??[]).filter(w=>w!==witness));
}
