-- F2-TAB-01 | Read-only inventory. For execution by a database reader only.
-- Connection must be read-only and the explicit transaction prevents any writes.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT r.version AS versao,r.status AS status_release,d.code AS dimensao,
       rd.membership_status AS status_dimensao,
       rc.membership_status AS status_conceito,
       count(DISTINCT rc.id)::int AS conceitos
FROM public.taxonomy_releases r
JOIN public.taxonomy_release_dimensions rd ON rd.release_id=r.id
JOIN public.taxonomy_dimensions d ON d.id=rd.dimension_id
LEFT JOIN public.taxonomy_concepts c ON c.dimension_id=d.id
LEFT JOIN public.taxonomy_release_concepts rc ON rc.release_id=r.id AND rc.concept_id=c.id
WHERE (r.version='v1.6.0' OR r.id='52791d3b-afdc-496f-8ada-c6cd5c819dff'::uuid)
  AND d.code IN ('treatment','act_type','platform','tax_species','sphere')
GROUP BY r.version,r.status,d.code,rd.membership_status,rc.membership_status
ORDER BY r.version,d.code,rc.membership_status;

WITH target_dimensions AS (
 SELECT id,code FROM public.taxonomy_dimensions
 WHERE code IN ('treatment','act_type','platform','tax_species','sphere')
), effective_manual AS (
 SELECT DISTINCT ON (t.publication_version_id,t.taxonomy_release_id,t.release_concept_id)
  t.publication_version_id,t.taxonomy_release_id,t.release_concept_id,t.action
 FROM public.publication_taxonomy_curator_tags t
 ORDER BY t.publication_version_id,t.taxonomy_release_id,t.release_concept_id,t.created_at DESC,t.id DESC
), tagged AS (
 SELECT 'AUTOMATICA_HISTORICA'::text AS tipo,a.taxonomy_release_id,
  c.dimension_id,a.run_id,pv.publication_id,a.release_concept_id
 FROM public.publication_taxonomy_assertions a
 JOIN public.taxonomy_release_concepts rc ON rc.id=a.release_concept_id
 JOIN public.taxonomy_concepts c ON c.id=rc.concept_id
 JOIN public.publication_taxonomy_runs run ON run.id=a.run_id
 LEFT JOIN public.publication_versions pv ON pv.id=run.publication_version_id
 WHERE a.assertion_status IN ('PROPOSED','CONFIRMED')
 UNION ALL
 SELECT 'MANUAL_ATIVA',m.taxonomy_release_id,c.dimension_id,NULL::uuid,pv.publication_id,m.release_concept_id
 FROM effective_manual m
 JOIN public.taxonomy_release_concepts rc ON rc.id=m.release_concept_id
 JOIN public.taxonomy_concepts c ON c.id=rc.concept_id
 LEFT JOIN public.publication_versions pv ON pv.id=m.publication_version_id
 WHERE m.action='ADD'
)
SELECT r.version,d.code AS dimensao,t.tipo,
 count(DISTINCT t.publication_id)::int AS publicacoes,
 count(DISTINCT t.release_concept_id)::int AS conceitos_marcados
FROM tagged t
JOIN target_dimensions d ON d.id=t.dimension_id
JOIN public.taxonomy_releases r ON r.id=t.taxonomy_release_id
GROUP BY r.version,d.code,t.tipo
ORDER BY r.version,d.code,t.tipo;

ROLLBACK;
