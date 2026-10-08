import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { sanitizeLegalPresentationHtml } from '../src/modules/collection/legal-presentation.js';

import {
  brazilLegalReferenceDate,
  renderedLegalText,
  type LegalScopeEvidenceV1,
} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';

/** Synthetic CI-only test assertion; NEVER reused by production connectors.
 * Test DB is disposable: the ledger remains append-only and these fixtures
 * are not deleted, even though the synthetic publication can be cleaned.
 */
export async function seedTestLegalScopeAttestation(
  admin: Pool,
  publicationVersionId: string,
  coverage: 'COMPLETE' | 'PARTIAL' = 'COMPLETE',
): Promise<string> {
  const version = await admin.query<{
    publication_id: string;
    presentation_html: string | null;
    presentation_format: string | null;
  }>(`
    SELECT publication_id,
      source_metadata -> 'presentation' ->> 'format' AS presentation_format,
      source_metadata -> 'presentation' ->> 'html' AS presentation_html
    FROM public.publication_versions WHERE id=$1::uuid
  `, [publicationVersionId]);
  const row=version.rows[0];
  if (!row?.presentation_html) throw new Error('TEST_PRESENTATION_REQUIRED');
  if (row.presentation_format !== 'SANITIZED_HTML') {
    throw new Error('TEST_SANITIZED_PRESENTATION_FORMAT_REQUIRED');
  }

  await admin.query(`
    INSERT INTO public.sources (code,name,jurisdiction_level,base_url,connector_key)
    VALUES ('confaz','CONFAZ','FEDERAL','https://www.confaz.fazenda.gov.br','confaz')
    ON CONFLICT (code) DO NOTHING
  `);
  const src=await admin.query<{id:string}>(`SELECT id FROM public.sources WHERE code='confaz'`);
  const sourceId=src.rows[0]!.id;
  const url='https://www.confaz.fazenda.gov.br/test-only/'+publicationVersionId;
  const origin=await admin.query<{id:string}>(`
    INSERT INTO public.publication_origins(publication_id,source_id,official_url)
    VALUES ($1::uuid,$2::uuid,$3)
    ON CONFLICT (source_id,official_url)
    WHERE metadata->>'officialUrlGranularity' IS DISTINCT FROM 'PAGE'
    DO UPDATE SET last_seen_at=now()
    RETURNING id
  `,[row.publication_id,sourceId,url]);

  const html=row.presentation_html;
  // A synthetic attestation must bind the exact public API HTML, too.
  if (sanitizeLegalPresentationHtml(html) !== html) {
    throw new Error('TEST_LEGAL_HTML_NOT_CANONICAL');
  }
  const text=renderedLegalText(html);
  if (!text) throw new Error('TEST_LEGAL_BODY_REQUIRED');

  // CI-only proof, not a portal adapter. The NCM fixture deliberately has
  // two DOM text nodes: a purely EDITORIAL title and the CURRENT legal body.
  // Neither a positive attestation nor a classifier may span both nodes.
  const fixtureTitleHtml = '<p class="TituloAcordo">CONVÊNIO ICMS — fixture</p>';
  const fixtureTitle = 'CONVÊNIO ICMS — fixture';
  const withTitle = html.startsWith(fixtureTitleHtml);
  if (withTitle && (!text.startsWith(fixtureTitle) ||
      !html.slice(fixtureTitleHtml.length).startsWith('<p class="TextoAcordo">'))) {
    throw new Error('TEST_UNSUPPORTED_TITLE_LAYOUT');
  }
  const bodyStart = withTitle ? fixtureTitle.length : 0;
  if (!text.slice(bodyStart)) throw new Error('TEST_LEGAL_BODY_REQUIRED');
  const h=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
  const validAsOf=brazilLegalReferenceDate();
  const recheck=new Date(validAsOf+'T12:00:00.000Z');
  recheck.setUTCDate(recheck.getUTCDate()+5);
  const m:LegalScopeEvidenceV1={
    version:1,
    publicationVersionId,sourceId,officialUrl:url,
    htmlSha256:h(html),validAsOf,
    verifiedAt:new Date(Date.now()-60_000).toISOString(),
    recheckOn:recheck.toISOString().slice(0,10),
    coverage,
    segments:[
      ...(withTitle ? [{
        start:0,end:bodyStart,textSha256:h(fixtureTitle),
        status:'EDITORIAL' as const,
        method:'ORIGINAL_PUBLICATION' as const,
        evidenceUrls:[],
      }] : []),
      {
        start:bodyStart,end:text.length,
        textSha256:h(text.slice(bodyStart)),
        status:'CURRENT' as const,
        method:'OFFICIAL_CONSOLIDATION' as const,
        evidenceUrls:[url],
      },
    ],
  };
  const inserted=await admin.query<{id:string}>(`
    INSERT INTO public.publication_legal_scope_attestations
      (publication_version_id,source_id,publication_origin_id,official_url,
       html_sha256,valid_as_of,verified_at,recheck_on,coverage,
       manifest,attestor_kind,attestor_ref)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::date,$7::timestamptz,
            $8::date,$10,$9::jsonb,'HUMAN_REVIEW','CI-ONLY-SYNTHETIC')
    RETURNING id
  `,[publicationVersionId,sourceId,origin.rows[0]!.id,url,h(html),
    validAsOf,m.verifiedAt,m.recheckOn,JSON.stringify(m),coverage]);
  return inserted.rows[0]!.id;
}
