-- DOE-SP rebuild — 12 exact row count of every table in schema public
-- (READ ONLY, aggregates only). Used to prove backup/restore fidelity.
-- jsonb_object_agg avoids jsonb_build_object's 100-argument limit as the
-- application schema grows.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot}
SET TRANSACTION SNAPSHOT :'snapshot';
\endif
SET LOCAL statement_timeout = '300s';
\ir 00_assert_read_only.sql
SELECT
  'SELECT ''DOE_SP_TABLE_COUNTS='' || ' ||
  'jsonb_object_agg(table_name, row_count ORDER BY table_name)::text ' ||
  'FROM (' ||
  string_agg(
    format(
      'SELECT %L AS table_name, count(*)::bigint AS row_count FROM public.%I',
      c.relname,
      c.relname
    ),
    ' UNION ALL '
    ORDER BY c.relname
  ) ||
  ') AS table_counts'
FROM pg_class c
JOIN pg_namespace n
  ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
\gexec
COMMIT;
