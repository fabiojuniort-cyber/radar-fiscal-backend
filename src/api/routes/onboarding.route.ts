import {dimensionGroups,dimensionGroupReviewed} from '../../modules/onboarding/assistant.dimensions.js';
import {onboardingCorrectionRoutes} from './onboarding-correction.route.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenantContext, TenantAccessDeniedError } from '../../infrastructure/database/tenant-context.js';
import { findLatestPublishedRelease, loadReleaseView, kyselyRunner } from '../../modules/taxonomy/curation/curation.read.js';
import {publishedAssistantReader} from '../../modules/onboarding/assistant.release.js';
import { emptyAssistant, mergeUnitCard, upgradeLegacyUnit, legacyActivityCards, selectableAssistantConcept, phraseSegment, phraseSegments, type AssistantState } from '../../modules/onboarding/assistant.model.js';

import { effectiveSelections, productNcmCodes, synchronizeUnit, strings, record, unique, legacyFieldNames, type UnitSelection } from '../../modules/onboarding/assistant.profile.js';

const params = z.object({ companyId: z.string().uuid() });
const query = z.object({establishmentId:z.string().uuid().optional()});
const selection = z.object({
  expectedVersion: z.number().int().min(0), releaseId: z.string().uuid(),
  cardId: z.string().regex(/^(company|establishments|summary|profile|dimension-group:[a-z_]+|dimension:[a-z_]+|cnae:[0-9]{7}|segment:[a-z0-9_.]+)$/),
  selectionMode: z.literal('EFFECTIVE').optional(),
  taxRegime: z.enum(['SIMPLES_NACIONAL','LUCRO_PRESUMIDO','LUCRO_REAL','IMUNE_ISENTA','OUTRO','NAO_INFORMADO']).optional(),
  legacyFields: z.object(Object.fromEntries(legacyFieldNames.map(key=>[key,z.array(z.string()).max(500).optional()]))).optional(),
  cnaeSegments: z.array(z.object({cnaeCode:z.string().regex(/^[0-9]{7}$/),segmentCode:z.string().nullable()})).max(200).optional(),
  establishmentId: z.string().uuid().optional(),
  units: z.array(z.object({establishmentId:z.string().uuid(),conceptCodes:z.array(z.string()).max(500),ncmCodes:z.array(z.string().regex(/^[0-9]{1,8}$/)).max(500)})).max(200).optional(),
  status: z.enum(['CONFIRMED', 'SKIPPED']),
  conceptCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)).max(500).default([]),
  ncmCodes: z.array(z.string().regex(/^[0-9]{1,8}$/)).max(500).default([]),
});
type Profile = { id: string; version_no: number; tax_regime: string; segments: string[]; activities: unknown;
  personalization: Record<string, unknown> };
type Override = { establishmentId: string; taxRegime: string; conceptCodes: string[]; ncmCodes: string[] };
class AssistantError extends Error { constructor(public status: number, public code: string) { super(code); } }
export async function onboardingRoutes(app: FastifyInstance) {
  await onboardingCorrectionRoutes(app);
  const readPublished=publishedAssistantReader();
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const path = '/api/v1/companies/:companyId/onboarding';
  for (const method of ['GET', 'PUT'] as const) typed.route({ method, url: path,
    preHandler: app.authenticate,
    schema: { params, querystring:query, ...(method === 'PUT' ? { body: selection } : {}) },
    handler: async (request, reply) => {
      if (!request.auth) return reply.code(401).send({ error: 'unauthorized' });
      const tenant = z.string().uuid().safeParse(request.headers['x-tenant-id']);
      if (!tenant.success) return reply.code(400).send({ error: 'tenant_required' });
      const started=performance.now();
      try {
        const result = await withTenantContext(app.db, request.auth.userId, tenant.data, async trx => {
          const run = kyselyRunner(trx);
          const member = await trx.selectFrom('tenant_memberships').select('role')
            .where('tenant_id', '=', tenant.data).where('user_id', '=', request.auth!.userId).executeTakeFirst();
          if (!['OWNER', 'ADMIN'].includes(member?.role ?? '')) throw new AssistantError(403, 'admin_required');
          const company = await trx.selectFrom('companies').select(['id', 'legal_name', 'head_office_cnpj'])
            .where('id', '=', request.params.companyId).where('is_active', '=', true).forUpdate().executeTakeFirst();
          if (!company) throw new AssistantError(404, 'company_not_found');
          const profiles = await run<Profile>('SELECT * FROM company_tax_profiles WHERE company_id=$1 AND is_current=true', [company.id]);
          const profile = profiles[0];
          const personalization = profile?.personalization ?? {};
          let state = (personalization.onboarding as AssistantState | undefined) ?? emptyAssistant();
          // Share the curator transaction lock: publication cannot race a card save.
          if(method==='PUT') await run('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['tribusca.taxonomy.curation']);
          const release = await findLatestPublishedRelease(run);
          if (!release) throw new AssistantError(409, 'taxonomy_release_not_available');
          if(state.releaseId && state.releaseId!==release.id) state=emptyAssistant();
          const snapshot = await readPublished(run, release.id);
          const view = snapshot?.view;
          if (!view) throw new AssistantError(409, 'taxonomy_release_not_available');
          const units = await run<{id:string; name:string; is_head_office:boolean; cnaes:{code:string;description:string}[]}>(`
            SELECT e.id,e.name,e.is_head_office,COALESCE(jsonb_agg(jsonb_build_object('code',c.code,'description',c.description) ORDER BY ec.is_primary DESC,c.code)
              FILTER(WHERE c.code IS NOT NULL),'[]'::jsonb) AS cnaes
            FROM establishments e LEFT JOIN establishment_cnaes ec ON ec.establishment_id=e.id
            LEFT JOIN cnaes c ON c.code=ec.cnae_code WHERE e.company_id=$1 AND e.is_active=true GROUP BY e.id ORDER BY e.is_head_office DESC,e.id`,[company.id]);
          const scopeId=query.parse(request.query).establishmentId;
          if(scopeId&&!units.some(u=>u.id===scopeId))throw new AssistantError(404,'establishment_not_found');
          const scopedUnits=scopeId?units.filter(u=>u.id===scopeId):units;
          const cards = (await Promise.all(scopedUnits.flatMap(unit => unit.cnaes.map(async cnae => {
            const links = snapshot!.links.filter(link=>link.cnae===cnae.code);
            const activity=view.concepts.find(c=>c.dimensionCode==='sector'&&c.officialCodes.some(code=>code.replace(/\D/g,'')===cnae.code));
            const group=view.groups.find(g=>g.id===activity?.groupId);
            const parents=view.concepts.filter(c=>c.dimensionCode==='sector'&&group?.segmentCodes.includes(c.code));
            const related=[...new Map([...parents,...view.concepts.filter(c=>c.dimensionCode==='sector'&&links.some(link=>link.segment===c.label))].map(c=>[c.code,c])).values()];
            const labels=new Set(related.map(c=>c.label));
            const fallback={code:'sector.sem_segmento',label:'Outras atividades'};
            const segments=[...related,...(!related.length||links.some(link=>!labels.has(link.segment))?[fallback]:[])];
            return segments.map(segment=>({
              establishmentId:unit.id,cnaeCode:cnae.code,description:cnae.description,
              segmentCode:segment.code,segmentLabel:segment.label,
              suggestions:[{kind:'SEGMENT',target:segment.code,segment:segment.label},
                ...links.filter(link=>segment.code==='sector.sem_segmento'?!labels.has(link.segment):link.segment===segment.label).map(link=>({kind:link.kind,target:link.target,segment:link.segment}))],
              phraseSegment:phraseSegment(segment.label),phraseSegments:phraseSegments(segment.label),
            }));
          })))).flat();
          const effective = effectiveSelections(profile,units);
          const included = view.concepts.filter(c=>c.membershipStatus==='INCLUDED');
          const known = new Set(included.map(c=>c.code));
          const dimensionCodes=['tax','regime','operation','operation_purpose','document','obligation','actuacao','subject','theme'];
          const dimensions=dimensionCodes.flatMap(code=>view.dimensions.filter(d=>d.code===code&&d.membershipStatus==='INCLUDED').map(d=>({code:d.code,name:d.name})));
          const scopedState=scopeId?{...state,cards:state.units[scopeId]?.cards??{},completed:state.units[scopeId]?.cards.summary?.status==='CONFIRMED'}:state;
          if (method === 'GET') {
            const historicalConcepts = new Map<string,{code:string;label:string;dimensionCode:string}>();
            for(const id of unique(effective.flatMap(u=>u.releaseId?[u.releaseId]:[]))){
              if(id===release.id || !z.string().uuid().safeParse(id).success)continue;
              const old=await loadReleaseView(run,id);
              for(const c of old?.concepts??[])if(!known.has(c.code))historicalConcepts.set(c.code,{code:c.code,label:c.label,dimensionCode:c.dimensionCode});
            }
            return { version:profile?.version_no??0,release,state:scopedState,cards:legacyActivityCards(cards),segmentCards:cards,
              dimensions,dimensionGroups,
              effectiveProfiles:effective.filter(u=>!scopeId||u.establishmentId===scopeId).map(unit=>({...unit,historicalCodes:unique([...unit.conceptCodes,...unit.cnaeSegments.flatMap(c=>c.segmentCode?[c.segmentCode]:[])]).filter(code=>!known.has(code))})),
              historicalConcepts:[...historicalConcepts.values()],
              concepts:included.map(c=>({code:c.code,label:c.label,dimensionCode:c.dimensionCode,ncmCodes:productNcmCodes(c)})),
              companyName:company.legal_name,companyCnpj:company.head_office_cnpj };
          }
          const body = selection.parse(request.body);
          if (body.expectedVersion !== (profile?.version_no ?? 0)) throw new AssistantError(409,'profile_version_conflict');
          if (body.releaseId !== release.id) throw new AssistantError(409,'taxonomy_release_changed');
          if(body.selectionMode==='EFFECTIVE'){
            const next:AssistantState={...structuredClone(state),releaseId:release.id};
            const overrides=structuredClone((personalization.establishmentOverrides??[]) as UnitSelection[]);
            let newPersonalization={...personalization},newRegime=profile?.tax_regime??'NAO_INFORMADO';
            let newSegments=profile?.segments??[],newActivities=profile?.activities??[];
            let selected:{establishmentId:string;conceptCodes:string[];ncmCodes:string[]}[]=[];
            if(body.cardId==='profile'){
              if(!body.establishmentId||body.units)throw new AssistantError(400,'invalid_card_payload');
              if(scopeId&&body.establishmentId!==scopeId)throw new AssistantError(400,'invalid_card_payload');
              selected=[{establishmentId:body.establishmentId,conceptCodes:body.conceptCodes,ncmCodes:body.ncmCodes}];
            }else if(body.cardId.startsWith('dimension:')||body.cardId.startsWith('dimension-group:')){
              if(!scopeId||body.establishmentId!==scopeId||body.units||body.ncmCodes.length||body.legacyFields||body.cnaeSegments||body.taxRegime)throw new AssistantError(400,'invalid_card_payload');
              const prior=effective.find(u=>u.establishmentId===scopeId)!;
              const group=dimensionGroups.find(g=>'dimension-group:'+g.code===body.cardId);
              const codes=group?group.dimensions:body.cardId.startsWith('dimension:')?[body.cardId.slice(10)]:[];
              const allowed=codes.filter(code=>dimensions.some(d=>d.code===code));
              if(!codes.length||(!group&&!allowed.length)||body.conceptCodes.some(c=>!included.some(v=>v.code===c&&allowed.includes(v.dimensionCode))))throw new AssistantError(400,'invalid_taxonomy_selection');
              selected=body.status==='SKIPPED'?[{establishmentId:scopeId,conceptCodes:prior.conceptCodes,ncmCodes:prior.ncmCodes}]:[{establishmentId:scopeId,conceptCodes:unique([...prior.conceptCodes.filter(c=>!included.some(v=>v.code===c&&allowed.includes(v.dimensionCode))),...body.conceptCodes]),ncmCodes:prior.ncmCodes}];
            }else if(body.cardId.startsWith('segment:')){
              const ids=unique(cards.filter(c=>'segment:'+c.segmentCode===body.cardId).map(c=>c.establishmentId));
              if(!ids.length||body.establishmentId||body.conceptCodes.length||body.ncmCodes.length||!body.units||body.units.length!==ids.length||new Set(body.units.map(u=>u.establishmentId)).size!==ids.length||body.units.some(u=>!ids.includes(u.establishmentId)))throw new AssistantError(400,'invalid_segment_units');
              selected=body.units;
            }else{
              if(!['company','establishments','summary'].includes(body.cardId)||body.establishmentId||body.units||body.conceptCodes.length||body.ncmCodes.length||body.legacyFields||body.cnaeSegments||body.taxRegime)throw new AssistantError(400,'invalid_card_payload');
              if(body.cardId==='summary'&&body.status==='CONFIRMED'){
                if(effective.filter(u=>!scopeId||u.establishmentId===scopeId).some(u=>u.conceptCodes.some(code=>!known.has(code))||u.cnaeSegments.some(c=>c.segmentCode&&!known.has(c.segmentCode))))throw new AssistantError(409,'taxonomy_selection_review_required');
                const completion=scopeId?next.units[scopeId]?.cards??{}:next.cards;
                if(!completion.company||(scopeId&&dimensionGroups.some(g=>!dimensionGroupReviewed(completion,g,dimensions.map(d=>d.code))))||cards.some(c=>!next.units[c.establishmentId]?.cards.profile&&!next.units[c.establishmentId]?.cards['segment:'+c.segmentCode]&&!next.units[c.establishmentId]?.cards['cnae:'+c.cnaeCode]))throw new AssistantError(409,'onboarding_cards_pending');
                next.completed=scopeId?units.every(u=>u.id===scopeId||next.units[u.id]?.cards.summary?.status==='CONFIRMED'):true;
              }
              const progress={status:body.status,conceptCodes:[],ncmCodes:[]};
              if(scopeId){const unit=next.units[scopeId]??{baseConceptCodes:[],baseNcmCodes:[],cards:{}};next.units[scopeId]={...unit,cards:{...unit.cards,[body.cardId]:progress}};}else next.cards[body.cardId]=progress;
            }
            for(const chosen of selected){
              const prior=effective.find(u=>u.establishmentId===chosen.establishmentId);
              if(!prior)throw new AssistantError(400,'invalid_establishment_cnae');
              const codes=unique(chosen.conceptCodes),ncms=unique(chosen.ncmCodes);
              if(body.status==='SKIPPED'){
                if(JSON.stringify(codes)!==JSON.stringify(prior.conceptCodes)||JSON.stringify(ncms)!==JSON.stringify(prior.ncmCodes))throw new AssistantError(400,'skipped_selection_changed');
              }else{
                if(codes.some(c=>!known.has(c)))throw new AssistantError(409,'taxonomy_selection_review_required');
                if(ncms.length){
                  const valid=await run<{code:string}>(`SELECT DISTINCT input.code FROM unnest($1::text[]) input(code) WHERE EXISTS(SELECT 1 FROM official_catalog_entries e JOIN official_catalog_editions ed ON ed.id=e.catalog_edition_id JOIN official_catalogs cat ON cat.id=ed.catalog_id WHERE cat.code='NCM' AND ed.status='CURRENT' AND regexp_replace(e.official_code,'[^0-9]','','g') LIKE input.code||'%')`,[ncms]);
                  if(valid.length!==ncms.length)throw new AssistantError(400,'invalid_ncm_codes');
                }
                if((body.legacyFields||body.cnaeSegments)&&(!prior.isHeadOffice||body.cardId!=='profile'))throw new AssistantError(400,'invalid_card_payload');
                if(body.taxRegime&&body.cardId!=='profile')throw new AssistantError(400,'invalid_card_payload');
                const replacement={establishmentId:prior.establishmentId,taxRegime:body.taxRegime??prior.taxRegime,conceptCodes:codes,ncmCodes:ncms,releaseId:release.id,releaseVersion:release.version};
                if(prior.isHeadOffice){
                  const oldTaxonomy=record(personalization.taxonomy);
                  const mappings=body.cnaeSegments??prior.cnaeSegments;
                  if(new Set(mappings.map(c=>c.cnaeCode)).size!==mappings.length||mappings.some(c=>!prior.cnaeSegments.some(p=>p.cnaeCode===c.cnaeCode)&&!units.some(u=>u.cnaes.some(n=>n.code===c.cnaeCode))))throw new AssistantError(400,'invalid_card_payload');
                  if(mappings.some(c=>c.segmentCode&&!included.some(v=>v.code===c.segmentCode&&v.dimensionCode==='sector'&&selectableAssistantConcept(v))))throw new AssistantError(409,'taxonomy_selection_review_required');
                  // Preserve the origin of untouched units when the matrix explicitly adopts a release.
                  if(typeof oldTaxonomy.releaseId==='string')for(const other of overrides)if(other.establishmentId!==prior.establishmentId&&!other.releaseId){other.releaseId=oldTaxonomy.releaseId;if(typeof oldTaxonomy.releaseVersion==='string')other.releaseVersion=oldTaxonomy.releaseVersion;}
                  newPersonalization={...newPersonalization,ncmCodes:ncms,taxonomy:{...oldTaxonomy,releaseId:release.id,releaseVersion:release.version,conceptCodes:codes,cnaeSegments:mappings}};
                  newRegime=replacement.taxRegime;
                  if(body.legacyFields)for(const key of legacyFieldNames){
                    const values=body.legacyFields[key];if(!values)continue;
                    if(values.some(v=>!prior.legacyFields[key].includes(v)))throw new AssistantError(400,'invalid_legacy_selection');
                    if(key==='segments')newSegments=values;else if(key==='activities')newActivities=values;else newPersonalization[key]=values;
                  }
                }
                const at=overrides.findIndex(o=>o.establishmentId===prior.establishmentId);if(at<0)overrides.push(replacement);else overrides[at]=replacement;
              }
              const related=new Set(cards.filter(c=>c.establishmentId===prior.establishmentId&&'segment:'+c.segmentCode===body.cardId).flatMap(c=>c.suggestions.map(s=>s.target)));
              const previous=next.units[prior.establishmentId];
              for(const c of codes)if(!prior.conceptCodes.includes(c))related.add(c);
              for(const n of ncms)if(!prior.ncmCodes.includes(n))related.add(n);
              next.units[prior.establishmentId]=synchronizeUnit(previous,body.cardId,body.status,{conceptCodes:codes,ncmCodes:ncms},related);
            }
            if(body.cardId!=='summary'){next.completed=false;if(scopeId&&next.units[scopeId])delete next.units[scopeId]!.cards.summary;}
            const today=new Date().toISOString().slice(0,10);
            if(profile)await trx.updateTable('company_tax_profiles').set({is_current:false,valid_to:today}).where('id','=',profile.id).execute();
            await trx.insertInto('company_tax_profiles').values({company_id:company.id,version_no:(profile?.version_no??0)+1,tax_regime:newRegime,segments:newSegments,activities:JSON.stringify(newActivities),personalization:JSON.stringify({...newPersonalization,establishmentOverrides:overrides,onboarding:next}),valid_from:today,valid_to:null,is_current:true}).execute();
            return {version:(profile?.version_no??0)+1,release,state:next,effectiveProfiles:effectiveSelections({tax_regime:newRegime,segments:newSegments,activities:newActivities,personalization:{...newPersonalization,establishmentOverrides:overrides}},units).filter(u=>!scopeId||u.establishmentId===scopeId).map(unit=>({...unit,historicalCodes:unique([...unit.conceptCodes,...unit.cnaeSegments.flatMap(c=>c.segmentCode?[c.segmentCode]:[])]).filter(code=>!known.has(code))}))};
          }
          if(scopeId)throw new AssistantError(400,'effective_selection_required');
          const currentCodes = new Set(view.concepts.filter(selectableAssistantConcept).map(c=>c.code));
          const chosenConcepts=[...body.conceptCodes,...(body.units??[]).flatMap(u=>u.conceptCodes)];
          const chosenNcms=[...new Set([...body.ncmCodes,...(body.units??[]).flatMap(u=>u.ncmCodes)])];
          if (chosenConcepts.some(code=>!currentCodes.has(code))) throw new AssistantError(400,'invalid_taxonomy_selection');
          if (chosenNcms.length) {
            const found = await run<{code:string}>(`SELECT DISTINCT input.code FROM unnest($1::text[]) input(code)
              WHERE EXISTS(SELECT 1 FROM official_catalog_entries e JOIN official_catalog_editions ed ON ed.id=e.catalog_edition_id
                JOIN official_catalogs cat ON cat.id=ed.catalog_id WHERE cat.code='NCM' AND ed.status='CURRENT'
                AND regexp_replace(e.official_code,'[^0-9]','','g') LIKE input.code || '%')`,[chosenNcms]);
            if (found.length !== chosenNcms.length) throw new AssistantError(400,'invalid_ncm_codes');
          }
          // Do not relabel unknown historical selections as members of a newer release.
          const priorTaxonomy=(personalization.taxonomy??{}) as {releaseId?:string;conceptCodes?:string[]};
          const priorOverrides=(personalization.establishmentOverrides??[]) as Override[];
          const knownCodes=new Set(view.concepts.map(c=>c.code));
          if(priorTaxonomy.releaseId && priorTaxonomy.releaseId!==release.id &&
            [...(priorTaxonomy.conceptCodes??[]),...priorOverrides.flatMap(unit=>unit.conceptCodes)].some(code=>!knownCodes.has(code)))
            throw new AssistantError(409,'taxonomy_selection_review_required');
          const next: AssistantState = {...structuredClone(state),releaseId:release.id};
          const item = { status:body.status,conceptCodes:body.conceptCodes,ncmCodes:body.ncmCodes };
          const overrides = structuredClone((personalization.establishmentOverrides ?? []) as Override[]);
          if (body.cardId.startsWith('segment:')) {
            const segment=body.cardId.slice(8);
            const members=cards.filter(c=>c.segmentCode===segment);
            const ids=[...new Set(members.map(c=>c.establishmentId))];
            if(!members.length || body.establishmentId || body.conceptCodes.length || body.ncmCodes.length ||
              !body.units || body.units.length!==ids.length ||
              new Set(body.units.map(u=>u.establishmentId)).size!==ids.length ||
              body.units.some(u=>!ids.includes(u.establishmentId)))
              throw new AssistantError(400,'invalid_segment_units');
            for(const unit of body.units){
              if(body.status==='SKIPPED'&&(unit.conceptCodes.length||unit.ncmCodes.length))throw new AssistantError(400,'invalid_card_payload');
              const existing=overrides.find(o=>o.establishmentId===unit.establishmentId);
              const baseline=next.units[unit.establishmentId]??{baseConceptCodes:existing?.conceptCodes??[],baseNcmCodes:existing?.ncmCodes??[],cards:{}};
              // Convert old CNAE contributions without losing their other segments or manual extras.
              const previous=upgradeLegacyUnit(baseline,cards.filter(c=>c.establishmentId===unit.establishmentId));
              const merged=mergeUnitCard(previous,body.cardId,{status:body.status,conceptCodes:unit.conceptCodes,ncmCodes:unit.ncmCodes});
              next.units[unit.establishmentId]=merged.unit;
              const replacement={establishmentId:unit.establishmentId,taxRegime:existing?.taxRegime??'NAO_INFORMADO',conceptCodes:merged.conceptCodes,ncmCodes:merged.ncmCodes};
              const index=overrides.findIndex(o=>o.establishmentId===unit.establishmentId);
              if(index<0)overrides.push(replacement);else overrides[index]=replacement;
            }
          } else if (body.cardId.startsWith('cnae:')) {
            if(body.units)throw new AssistantError(400,'invalid_card_payload');
            const cnae = body.cardId.slice(5);
            if (!body.establishmentId || !cards.some(c=>c.establishmentId===body.establishmentId && c.cnaeCode===cnae))
              throw new AssistantError(400,'invalid_establishment_cnae');
            const existing = overrides.find(o=>o.establishmentId===body.establishmentId);
            const baseline = next.units[body.establishmentId] ?? { baseConceptCodes:existing?.conceptCodes ?? [],
              baseNcmCodes:existing?.ncmCodes ?? [], cards:{} };
            const merged = mergeUnitCard(baseline,body.cardId,item);
            next.units[body.establishmentId] = merged.unit;
            const replacement = { establishmentId:body.establishmentId,taxRegime:existing?.taxRegime ?? 'NAO_INFORMADO',
              conceptCodes:merged.conceptCodes,ncmCodes:merged.ncmCodes };
            const index = overrides.findIndex(o=>o.establishmentId===body.establishmentId);
            if(index<0) overrides.push(replacement); else overrides[index]=replacement;
          } else {
            if(body.units || body.establishmentId || body.conceptCodes.length || body.ncmCodes.length) throw new AssistantError(400,'invalid_card_payload');
            if(body.cardId==='summary' && body.status==='CONFIRMED') {
              if(!next.cards.company || cards.some(card=>!next.units[card.establishmentId]?.cards['segment:'+card.segmentCode]&&!next.units[card.establishmentId]?.cards['cnae:'+card.cnaeCode]))
                throw new AssistantError(409,'onboarding_cards_pending');
              next.completed=true;
            }
            next.cards[body.cardId]=item;
          }
          if(body.cardId!=='summary') next.completed=false;
          const today = new Date().toISOString().slice(0,10);
          if(profile) await trx.updateTable('company_tax_profiles').set({is_current:false,valid_to:today}).where('id','=',profile.id).execute();
          await trx.insertInto('company_tax_profiles').values({company_id:company.id,version_no:(profile?.version_no??0)+1,
            tax_regime:profile?.tax_regime??'NAO_INFORMADO',segments:profile?.segments??[],activities:JSON.stringify(profile?.activities??[]),
            personalization:JSON.stringify({...personalization,establishmentOverrides:overrides,onboarding:next,
              taxonomy:{...((personalization.taxonomy??{}) as object),releaseId:release.id,releaseVersion:release.version,
                conceptCodes:((personalization.taxonomy??{}) as {conceptCodes?:string[]}).conceptCodes??[]}}),
            valid_from:today,valid_to:null,is_current:true}).execute();
          return {version:(profile?.version_no??0)+1,release,state:next};
        });
        reply.header('Server-Timing',`onboarding;dur=${(performance.now()-started).toFixed(1)}`);
        return reply.send(result);
      } catch(error) {
        if(error instanceof TenantAccessDeniedError) return reply.code(403).send({error:'tenant_access_denied'});
        if(error instanceof AssistantError) return reply.code(error.status).send({error:error.code});
        throw error;
      }
    }
  });
}


