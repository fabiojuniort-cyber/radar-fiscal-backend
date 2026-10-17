-- ONB-02-R3 — PRIVATE COMPANY GRAPH MANIFEST (READ ONLY).
-- REQUIRES: psql -X -v ON_ERROR_STOP=1 -v company_id='<UUID>' -f <this-file>
-- Operator must keep output in restricted evidence store; no raw names/CNPJs.
-- This file can inspect PRD read-only after approval, or restored PG clone.
\if :{?company_id}
\else
\echo 'BLOCK: supply explicit company_id. No query executed.'
\quit 4
\endif

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT CASE WHEN :'company_id' ~
  '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
  THEN 'VALID_INPUT' ELSE 'INVALID_INPUT' END AS uuid_input_status;

-- Counts of every known company-owned relation. No raw PII in results.
WITH target AS (
 SELECT id,tenant_id,head_office_cnpj,legal_name,trade_name
 FROM companies WHERE id=:'company_id'::uuid
), units AS (
 SELECT id FROM establishments WHERE company_id=:'company_id'::uuid
), products AS (
 SELECT id FROM company_product_profiles WHERE company_id=:'company_id'::uuid
), pubs AS (
 SELECT id,publication_id FROM company_publications WHERE company_id=:'company_id'::uuid
), monitoring AS (
 SELECT id FROM monitoring_profiles WHERE company_id=:'company_id'::uuid
)
SELECT
 (SELECT count(*) FROM target) AS companies,
 (SELECT count(*) FROM units) AS establishments,
 (SELECT count(*) FROM establishment_cnaes ec JOIN units u ON u.id=ec.establishment_id) AS establishment_cnaes,
 (SELECT count(*) FROM company_cnaes cc WHERE cc.company_id=:'company_id'::uuid) AS company_cnaes,
 (SELECT count(*) FROM company_tax_profiles p WHERE p.company_id=:'company_id'::uuid) AS tax_versions,
 (SELECT count(*) FROM products) AS product_profiles,
 (SELECT count(*) FROM company_product_ncms n JOIN products p ON p.id=n.company_product_profile_id) AS product_ncms,
 (SELECT count(*) FROM company_cnae_ncms n WHERE n.company_id=:'company_id'::uuid) AS cnae_ncms,
 (SELECT count(*) FROM monitoring) AS monitoring_profiles,
 (SELECT count(*) FROM pubs) AS company_publications,
 (SELECT count(*) FROM publication_matches pm
    WHERE pm.company_publication_id IN (SELECT id FROM pubs)
       OR pm.monitoring_profile_id IN (SELECT id FROM monitoring)) AS publication_matches,
 (SELECT count(*) FROM publication_matches pm
    JOIN company_publications cp ON cp.id=pm.company_publication_id
    JOIN monitoring_profiles mp ON mp.id=pm.monitoring_profile_id
    WHERE (cp.company_id=:'company_id'::uuid OR mp.company_id=:'company_id'::uuid)
      AND cp.company_id<>mp.company_id) AS cross_company_matches,
 (SELECT count(*) FROM tenant_onboarding_profiles tp JOIN target t ON t.tenant_id=tp.tenant_id
    WHERE tp.cnpj=t.head_office_cnpj) AS explicitly_linked_legacy_onboarding,
 (SELECT count(*) FROM tenant_onboarding_profiles tp JOIN target t ON t.tenant_id=tp.tenant_id
    WHERE tp.cnpj IS NULL AND tp.company_name IS NOT NULL
      AND (tp.company_name=t.legal_name OR tp.company_name=t.trade_name)) AS ambiguous_legacy_names,
 (SELECT count(*) FROM audit_log a
    WHERE a.entity_type IN ('company','establishment')
      AND (a.entity_id=:'company_id' OR a.entity_id IN
        (SELECT e.id::text FROM establishments e WHERE e.company_id=:'company_id'::uuid))
 ) AS historical_id_based_audits_company_or_branches,
 (SELECT count(*) FROM audit_log a
    WHERE a.before_data::text LIKE '%'||:'company_id'||'%'
       OR a.after_data::text LIKE '%'||:'company_id'||'%'
       OR EXISTS (
         SELECT 1 FROM establishments e WHERE e.company_id=:'company_id'::uuid
           AND (a.before_data::text LIKE '%'||e.id::text||'%'
             OR a.after_data::text LIKE '%'||e.id::text||'%')
       )
 ) AS historical_payload_id_references;

-- Global/publication preservation: rows in publications and versions are not
-- company-owned. This digest must be evaluated on the restore before and
-- after the dry-run using a private list of referenced publication IDs; the
-- collection links disappear after deletion, so retain the before-list in a
-- separate restricted artifact (not GitHub or screenshots).
SELECT count(*) AS global_publications_total,
       md5(coalesce(string_agg(md5(to_jsonb(p)::text),''
             ORDER BY p.id),'EMPTY')) AS publications_digest
FROM publications p;

SELECT count(*) AS global_versions_total,
       md5(coalesce(string_agg(md5(to_jsonb(v)::text),''
             ORDER BY v.publication_id,v.id),'EMPTY')) AS versions_digest
FROM publication_versions v;

SELECT count(*) AS global_cnaes_total,
       md5(coalesce(string_agg(md5(to_jsonb(c)::text),''
             ORDER BY c.code),'EMPTY')) AS cnaes_digest
FROM cnaes c;

-- Unrelated companies and their private dependencies must be byte-identical
-- before/after a company purge in the isolated restore. Never expose rows.
SELECT 'other_companies' AS relation,
       count(*)::bigint AS rows,
       md5(coalesce(string_agg(md5(to_jsonb(c)::text),'' ORDER BY c.id),'EMPTY')) AS fingerprint
FROM companies c WHERE c.id <> :'company_id'::uuid
UNION ALL
SELECT 'other_establishments',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(e)::text),'' ORDER BY e.id),'EMPTY'))
FROM establishments e WHERE e.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_tax_profiles',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' ORDER BY p.id),'EMPTY'))
FROM company_tax_profiles p WHERE p.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_products',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' ORDER BY p.id),'EMPTY'))
FROM company_product_profiles p WHERE p.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_monitoring_profiles',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(mp)::text),'' ORDER BY mp.id),'EMPTY'))
FROM monitoring_profiles mp WHERE mp.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_company_publications',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(cp)::text),'' ORDER BY cp.id),'EMPTY'))
FROM company_publications cp WHERE cp.company_id <> :'company_id'::uuid
UNION ALL
SELECT 'other_matches',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(pm)::text),'' ORDER BY pm.id),'EMPTY'))
FROM publication_matches pm JOIN company_publications cp
  ON cp.id=pm.company_publication_id WHERE cp.company_id <> :'company_id'::uuid;

-- Other companies' relationship tables must be preserved too. The
-- synthetic test must seed these and assert unchanged fingerprints.
SELECT 'other_company_cnaes' AS relation,count(*)::bigint AS rows,
       md5(coalesce(string_agg(md5(to_jsonb(cc)::text),'' ORDER BY cc.company_id,cc.cnae_code),'EMPTY')) AS fingerprint
FROM company_cnaes cc WHERE cc.company_id<>:'company_id'::uuid
UNION ALL
SELECT 'other_establishment_cnaes',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(ec)::text),'' ORDER BY ec.establishment_id,ec.cnae_code),'EMPTY'))
FROM establishment_cnaes ec JOIN establishments e ON e.id=ec.establishment_id
WHERE e.company_id<>:'company_id'::uuid
UNION ALL
SELECT 'other_company_product_ncms',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(n)::text),''
         ORDER BY n.company_product_profile_id,n.official_catalog_entry_id),'EMPTY'))
FROM company_product_ncms n JOIN company_product_profiles p
  ON p.id=n.company_product_profile_id
WHERE p.company_id<>:'company_id'::uuid
UNION ALL
SELECT 'other_company_cnae_ncms',count(*)::bigint,
       md5(coalesce(string_agg(md5(to_jsonb(n)::text),'' ORDER BY n.id),'EMPTY'))
FROM company_cnae_ncms n WHERE n.company_id<>:'company_id'::uuid;

-- Snapshot global/non-company tables, including source records, taxonomies,
-- catalog editions/entries and publication attachments. Dynamic discovery
-- ensures newly added matching tables are not silently omitted.
-- WARNING: hashing full payloads can be expensive; compare on authorized
-- isolated datasets. These are only hashes and counts, never raw legal/PII.
DO $onb02_global$
DECLARE
  source_table regclass;
  number_of_rows bigint;
  row_digest text;
BEGIN
  FOR source_table IN
    SELECT c.oid::regclass
    FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace
      AND c.relkind IN ('r','p')
      AND (
        c.relname IN ('publications','cnaes','official_sources','sources')
        OR c.relname LIKE 'publication_%'
        OR c.relname LIKE 'taxonomy_%'
        OR c.relname LIKE 'official_catalog%'
        OR c.relname LIKE 'source_%'
      )
      AND c.relname NOT IN ('publication_matches')
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT count(*)::bigint, md5(coalesce(string_agg(md5(to_jsonb(t)::text),'''' ORDER BY md5(to_jsonb(t)::text)),''EMPTY'')) FROM %s t',
      source_table
    ) INTO number_of_rows,row_digest;
    RAISE NOTICE 'ONB02_GLOBAL relation=% rows=% fingerprint=%',
      source_table,number_of_rows,row_digest;
  END LOOP;
END $onb02_global$;

-- The old parents will disappear after COMMIT. Prior to an authorized purge,
-- capture the complete scope privately, including CNPJ digits, tenant UUID,
-- company UUID, establishment/product/tax/monitoring/publication/match UUIDs.
-- Supply original_* values only within restricted psql sessions, NOT via
-- visible shell arguments, GitHub issues or public Actions. No raw values
-- are printed by these queries. A missing original scope after purge must
-- be classified NOT_PROVEN rather than 'zero residual data'.
\if :{?original_tenant_id}
\else
\set original_tenant_id ''
\endif
\if :{?original_establishment_ids}
\else
\set original_establishment_ids ''
\endif
\if :{?original_tax_profile_ids}
\else
\set original_tax_profile_ids ''
\endif
\if :{?original_product_profile_ids}
\else
\set original_product_profile_ids ''
\endif
\if :{?original_monitoring_profile_ids}
\else
\set original_monitoring_profile_ids ''
\endif
\if :{?original_company_publication_ids}
\else
\set original_company_publication_ids ''
\endif
\if :{?original_publication_match_ids}
\else
\set original_publication_match_ids ''
\endif
\if :{?original_cnpjs}
\else
\set original_cnpjs ''
\endif

WITH private_company AS (
  SELECT id,tenant_id,head_office_cnpj FROM companies
  WHERE id=:'company_id'::uuid
),
current_ids AS (
  SELECT id::text FROM private_company
  UNION ALL SELECT id::text FROM establishments WHERE company_id=:'company_id'::uuid
  UNION ALL SELECT id::text FROM company_tax_profiles WHERE company_id=:'company_id'::uuid
  UNION ALL SELECT id::text FROM company_product_profiles WHERE company_id=:'company_id'::uuid
  UNION ALL SELECT id::text FROM monitoring_profiles WHERE company_id=:'company_id'::uuid
  UNION ALL SELECT id::text FROM company_publications WHERE company_id=:'company_id'::uuid
  UNION ALL
    SELECT pm.id::text FROM publication_matches pm
    JOIN company_publications cp ON cp.id=pm.company_publication_id
    WHERE cp.company_id=:'company_id'::uuid
),
saved_ids AS (
  SELECT btrim(id) AS id FROM unnest(ARRAY[
    :'original_establishment_ids', :'original_tax_profile_ids',
    :'original_product_profile_ids', :'original_monitoring_profile_ids',
    :'original_company_publication_ids', :'original_publication_match_ids'
  ]) AS group_ids
  CROSS JOIN LATERAL regexp_split_to_table(group_ids,',') AS id
),
all_ids AS (
  SELECT DISTINCT lower(id) AS id FROM (
    SELECT id FROM current_ids
    UNION ALL SELECT :'company_id'::text
    UNION ALL SELECT id FROM saved_ids
  ) s
  WHERE id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
current_cnpjs AS (
  SELECT head_office_cnpj::text AS digits FROM private_company
  UNION ALL SELECT cnpj::text FROM establishments WHERE company_id=:'company_id'::uuid
),
saved_cnpjs AS (
  SELECT regexp_replace(btrim(raw),'[^0-9]','','g') AS digits
  FROM regexp_split_to_table(:'original_cnpjs',',') AS raw
),
all_cnpjs AS (
  SELECT DISTINCT digits FROM (
    SELECT digits FROM current_cnpjs UNION ALL SELECT digits FROM saved_cnpjs
  ) raw
  WHERE digits ~ '^[0-9]{14}$'
),
audit_scope AS (
  SELECT a.* FROM audit_log a
  WHERE a.tenant_id=coalesce(
    (SELECT tenant_id FROM private_company),
    nullif(:'original_tenant_id','')::uuid
  )
)
SELECT
  CASE
    WHEN EXISTS(SELECT 1 FROM private_company) THEN 'CURRENT_SCOPE_VISIBLE'
    WHEN nullif(:'original_tenant_id','') IS NULL
       OR nullif(:'original_establishment_ids','') IS NULL
       OR nullif(:'original_cnpjs','') IS NULL
      THEN 'BLOCK_POST_PURGE_PRIVATE_SCOPE_MISSING'
    ELSE 'SAVED_SCOPE_NEEDS_CLASSIFICATION'
  END AS evidence_scope_status,
  (SELECT count(*) FROM all_ids) AS old_ids_covered,
  (SELECT count(*) FROM all_cnpjs) AS original_cnpjs_covered,
  count(*) FILTER(WHERE a.entity_id IN (SELECT id FROM all_ids))
    AS historical_entity_id_mentions,
  count(*) FILTER(WHERE EXISTS (
     SELECT 1 FROM all_ids x WHERE
       coalesce(a.before_data::text,'') ILIKE '%'||x.id||'%'
       OR coalesce(a.after_data::text,'') ILIKE '%'||x.id||'%'
  )) AS historical_payload_id_mentions,
  count(*) FILTER(WHERE EXISTS (
    SELECT 1 FROM all_cnpjs x
    WHERE regexp_replace(coalesce(a.before_data::text,''),'[^0-9]','','g')
          LIKE '%'||x.digits||'%'
       OR regexp_replace(coalesce(a.after_data::text,''),'[^0-9]','','g')
          LIKE '%'||x.digits||'%'
       OR regexp_replace(coalesce(a.entity_id,''),'[^0-9]','','g')
          LIKE '%'||x.digits||'%'
  )) AS historical_cnpj_mentions
FROM audit_scope a;

-- These are historical retention/classification indicators, NOT automatic
-- targets for DELETE: compliance audit rows may need to remain, and official
-- publications mentioning the CNPJ must remain in the global legal Acervo.
-- Any additional JSON/text candidate identified by preflight-readonly.sql
-- requires an explicit signed classification, not an inferred blanket wipe.

ROLLBACK;
