-- DOE-SP rebuild — read-only session guard.
-- Included at the top of every read-only file. Aborts (ON_ERROR_STOP) unless
-- the current transaction is READ ONLY at server level.
DO $$
BEGIN
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'DOE-SP ops: refusing to run outside a READ ONLY transaction';
  END IF;
END
$$;
