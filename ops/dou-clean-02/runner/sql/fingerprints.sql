-- SHA-256 computed INSIDE PostgreSQL. No canonical content/tenant rows exported.
-- Discover all downstream FK paths (including composite keys); bound traversal.
-- Scope ledger and feed change intentionally and are audited separately.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH RECURSIVE edges(child,parent,child_cols,parent_cols) AS (
  -- Catalog `name` columns have collation "C"; the recursive term must match
  -- the non-recursive literals (collation "default") column by column.
  SELECT c.relname::text COLLATE "default",p.relname::text COLLATE "default",
    string_agg(format('%I',ca.attname),',' ORDER BY k.n) COLLATE "default",
    string_agg(format('%I',pa.attname),',' ORDER BY k.n) COLLATE "default"
  FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid
  JOIN pg_namespace cn ON cn.oid=c.relnamespace JOIN pg_namespace pn ON pn.oid=p.relnamespace
  CROSS JOIN LATERAL unnest(f.conkey,f.confkey) WITH ORDINALITY k(c,p,n)
  JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=k.c
  JOIN pg_attribute pa ON pa.attrelid=p.oid AND pa.attnum=k.p
  WHERE f.contype='f' AND cn.nspname='public' AND pn.nspname='public'
  GROUP BY f.oid,c.relname,p.relname
  UNION
  -- These operational tables intentionally have no physical version FK.
  SELECT x,'publication_versions','publication_version_id','id'
  FROM unnest(ARRAY['publication_taxonomy_scans','publication_taxonomy_curator_tags']) x
), paths(rel,predicate,visited) AS (
  SELECT 'publications'::text,format('id=%L::uuid',:'publication_id'),ARRAY['publications']::text[]
  UNION ALL
  SELECT e.child,format('(%s) IN (SELECT %s FROM public.%I WHERE %s)',e.child_cols,e.parent_cols,e.parent,p.predicate),
    p.visited||e.child
  FROM paths p JOIN edges e ON e.parent=p.rel
  WHERE NOT e.child=ANY(p.visited) AND cardinality(p.visited)<12
    AND e.child NOT IN ('publication_source_feed','publication_scope_events','publication_scope_state','publication_scope_epoch_state')
), grouped AS (
  SELECT rel,string_agg('('||predicate||')',' OR ' ORDER BY predicate) AS predicate FROM paths GROUP BY rel
)
SELECT format($q$
  SELECT jsonb_build_object(%L,jsonb_build_object('count',count(*)::text,'sha256',
    encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex'),''
      ORDER BY encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex')),''),'UTF8')),'hex')))
  FROM public.%I x WHERE %s;
$q$,rel,rel,predicate) FROM grouped ORDER BY rel
\gexec

WITH rows AS (
  SELECT 'linked_taxonomy_candidates'::text AS category,to_jsonb(c)::text AS row
  FROM public.taxonomy_candidates c WHERE EXISTS (
    SELECT 1 FROM public.taxonomy_candidate_occurrence_links l
    JOIN public.taxonomy_unmapped_occurrences o ON o.id=l.occurrence_id
    JOIN public.publication_taxonomy_runs r ON r.id=o.run_id
    JOIN public.publication_versions v ON v.id=r.publication_version_id
    WHERE l.candidate_id=c.id AND v.publication_id=:'publication_id'::uuid)
  UNION ALL
  SELECT 'historical_collection_runs',to_jsonb(r)::text FROM public.collection_runs r
  WHERE r.id=ANY(:'run_ids'::uuid[])
  UNION ALL
  SELECT 'historical_imported_documents',to_jsonb(x)::text FROM (
    SELECT collection_run_id,count(*) FILTER (WHERE disposition IN ('NEW_PUBLICATION','NEW_VERSION'))::text AS imported
    FROM public.collection_run_publications WHERE collection_run_id=ANY(:'run_ids'::uuid[])
    GROUP BY collection_run_id) x
), categories(category) AS (VALUES ('linked_taxonomy_candidates'),('historical_collection_runs'),('historical_imported_documents'))
SELECT jsonb_build_object(c.category,jsonb_build_object('count',count(r.row)::text,'sha256',
  encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(r.row,'UTF8')),'hex'),''
    ORDER BY encode(sha256(convert_to(r.row,'UTF8')),'hex')),''),'UTF8')),'hex')))
FROM categories c LEFT JOIN rows r USING(category) GROUP BY c.category ORDER BY c.category;
ROLLBACK;
