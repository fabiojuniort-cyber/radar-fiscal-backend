-- ONB-01: enforce invariant at persistence boundary, including legacy routes.
-- Existing rows remain untouched. Trigger checks only identity changes and inserts.
CREATE FUNCTION guard_establishment_company_root()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_head_office_cnpj TEXT;
BEGIN
    SELECT head_office_cnpj INTO v_head_office_cnpj
      FROM companies WHERE id = NEW.company_id;
    IF v_head_office_cnpj IS NULL
       OR left(NEW.cnpj, 8) <> left(v_head_office_cnpj, 8) THEN
        RAISE EXCEPTION 'establishment_cnpj_root_mismatch'
          USING ERRCODE = '23514',
                CONSTRAINT = 'chk_establishment_company_root';
    END IF;
    IF NEW.is_head_office AND NEW.cnpj <> v_head_office_cnpj THEN
        RAISE EXCEPTION 'head_office_conflict'
          USING ERRCODE = '23514',
                CONSTRAINT = 'chk_establishment_head_office_identity';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_establishment_company_root
BEFORE INSERT OR UPDATE OF company_id, cnpj, is_head_office
ON establishments
FOR EACH ROW EXECUTE FUNCTION guard_establishment_company_root();
REVOKE ALL ON FUNCTION guard_establishment_company_root() FROM PUBLIC;
