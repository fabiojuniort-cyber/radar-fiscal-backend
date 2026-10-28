-- Aggregate the public Agrex matrix's OWN registered CNAEs against the current published release.
-- No saved selections are counted; no row/tenant/unit identifiers are returned.
WITH release AS (
 SELECT id,manifest FROM public.taxonomy_releases WHERE status='PUBLISHED'
 ORDER BY version_major DESC,version_minor DESC,version_patch DESC LIMIT 1
), unit_cnaes AS (
 SELECT DISTINCT ec.cnae_code FROM public.establishment_cnaes ec
 JOIN public.establishments e ON e.id=ec.establishment_id
 WHERE e.cnpj='10515785000199' AND e.is_active
), links AS (
 SELECT DISTINCT l->>'segment' AS segment,l->>'kind' AS kind,l->>'target' AS target,l->>'cnae' AS cnae
 FROM release r CROSS JOIN LATERAL jsonb_array_elements(r.manifest->'f2Operational'->'links') l
 WHERE l->>'cnae' IN (SELECT cnae_code FROM unit_cnaes)
), product_ncms AS (
 SELECT DISTINCT l.segment,replace(code,'.','') AS target FROM links l
 JOIN public.taxonomy_concepts c ON c.code=l.target
 JOIN public.taxonomy_release_concepts rc ON rc.concept_id=c.id AND rc.release_id=(SELECT id FROM release) AND rc.membership_status='INCLUDED'
 CROSS JOIN LATERAL unnest(rc.official_codes) code
 WHERE l.kind='PRODUCT' AND code ~ '^[0-9.]+$' AND replace(code,'.','') ~ '^[0-9]{1,8}$'
), all_ncms AS (
 SELECT segment,target FROM links WHERE kind='NCM' UNION SELECT segment,target FROM product_ncms
), segments AS (SELECT DISTINCT segment FROM links)
SELECT s.segment,
 (SELECT count(DISTINCT cnae) FROM links l WHERE l.segment=s.segment) AS cnaes_with_links,
 (SELECT count(DISTINCT target) FROM links l WHERE l.segment=s.segment AND kind='PRODUCT') AS products,
 (SELECT count(DISTINCT target) FROM all_ncms n WHERE n.segment=s.segment) AS ncms
FROM segments s
UNION ALL
SELECT 'TOTAL_UNICO',(SELECT count(*) FROM unit_cnaes),
 (SELECT count(DISTINCT target) FROM links WHERE kind='PRODUCT'),(SELECT count(DISTINCT target) FROM all_ncms)
ORDER BY segment;
