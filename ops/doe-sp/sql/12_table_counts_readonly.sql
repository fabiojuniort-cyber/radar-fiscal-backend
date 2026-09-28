-- DOE-SP rebuild — 12 exact row count of every table in schema public
-- (READ ONLY, aggregates only). Used to prove backup/restore fidelity.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot}
SET TRANSACTION SNAPSHOT :'snapshot';
\endif
SET LOCAL statement_timeout = '300s';
\ir 00_assert_read_only.sql
SELECT 'SELECT ''DOE_SP_TABLE_COUNTS='' || jsonb_build_object(' ||
  string_agg(format('%L, (SELECT count(*) FROM public.%I)', c.relname, c.relname), ', ' ORDER BY c.relname) ||
  ')::text'
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
\gexec
COMMIT;
