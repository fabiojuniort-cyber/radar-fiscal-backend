import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTenantContext, TenantAccessDeniedError } from '../../infrastructure/database/tenant-context.js';
import { findLatestPublishedRelease, loadReleaseView, kyselyRunner } from '../../modules/taxonomy/curation/curation.read.js';
import { publishedOperationalLinks } from '../../modules/taxonomy/curation/curation.f2-links.js';
import { emptyAssistant, mergeUnitCard, upgradeLegacyUnit, selectableAssistantConcept, phraseSegment, phraseSegments, type AssistantState } from '../../modules/onboarding/assistant.model.js';

const params = z.object({ companyId: z.string().uuid() });
const selection = z.object({
  expectedVersion: z.number().int().min(0), releaseId: z.string().uuid(),
  cardId: z.string().regex(/^(company|establishments|summary|cnae:[0-9]{7}|segment:[a-z0-9_.]+)$/),
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
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const path = '/api/v1/companies/:companyId/onboarding';
  for (const method of ['GET', 'PUT'] as const) typed.route({ method, url: path,
    preHandler: app.authenticate,
    schema: { params, ...(method === 'PUT' ? { body: selection } : {}) },
    handler: async (request, reply) => {
      if (!request.auth) return reply.code(401).send({ error: 'unauthorized' });
      const tenant = z.string().uuid().safeParse(request.headers['x-tenant-id']);
      if (!tenant.success) return reply.code(400).send({ error: 'tenant_required' });
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
          const view = await loadReleaseView(run, release.id);
          if (!view) throw new AssistantError(409, 'taxonomy_release_not_available');
          const units = await run<{id:string; cnaes:{code:string;description:string}[]}>(`
            SELECT e.id,COALESCE(jsonb_agg(jsonb_build_object('code',c.code,'description',c.description) ORDER BY ec.is_primary DESC,c.code)
              FILTER(WHERE c.code IS NOT NULL),'[]'::jsonb) AS cnaes
            FROM establishments e LEFT JOIN establishment_cnaes ec ON ec.establishment_id=e.id
            LEFT JOIN cnaes c ON c.code=ec.cnae_code WHERE e.company_id=$1 AND e.is_active=true GROUP BY e.id ORDER BY e.is_head_office DESC,e.id`,[company.id]);
          const cards = (await Promise.all(units.flatMap(unit => unit.cnaes.map(async cnae => {
            const links = await publishedOperationalLinks(run,cnae.code);
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
          if (method === 'GET') return { version:profile?.version_no ?? 0,release,state,cards,
            concepts:view.concepts.filter(selectableAssistantConcept).map(c => ({code:c.code,label:c.label,dimensionCode:c.dimensionCode})),
            companyName:company.legal_name,companyCnpj:company.head_office_cnpj };
          const body = selection.parse(request.body);
          if (body.expectedVersion !== (profile?.version_no ?? 0)) throw new AssistantError(409,'profile_version_conflict');
          if (body.releaseId !== release.id) throw new AssistantError(409,'taxonomy_release_changed');
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
              if(!next.cards.company || !next.cards.establishments || cards.some(card=>!next.units[card.establishmentId]?.cards['segment:'+card.segmentCode]&&!next.units[card.establishmentId]?.cards['cnae:'+card.cnaeCode]))
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
        return reply.send(result);
      } catch(error) {
        if(error instanceof TenantAccessDeniedError) return reply.code(403).send({error:'tenant_access_denied'});
        if(error instanceof AssistantError) return reply.code(error.status).send({error:error.code});
        throw error;
      }
    }
  });
}
