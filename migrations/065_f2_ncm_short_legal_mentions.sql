-- F2 / NCM-03: Preserve existing full NCM checks but permit context-backed
-- 2/4/6-digit prefix evidence. Never reinterpret it as an assignable 8-digit NCM.
-- All changes remain in DRAFT PR #216; no automatic deployment.

-- PostgreSQL blocks ALTER TYPE while this trigger depends on ncm_code;
-- migrations execute transactionally, then the revised guard is restored.
DROP TRIGGER IF EXISTS trg_publication_ncm_catalog ON publication_ncm_mentions;

ALTER TABLE publication_ncm_mentions
  ALTER COLUMN ncm_code TYPE VARCHAR(8)
  USING btrim(ncm_code::text);

ALTER TABLE publication_ncm_mentions
  DROP CONSTRAINT IF EXISTS publication_ncm_mentions_ncm_code_check;

ALTER TABLE publication_ncm_mentions
  ADD CONSTRAINT chk_publication_ncm_prefix_width
  CHECK (ncm_code ~ '^[0-9]{2}([0-9]{2}([0-9]{2}([0-9]{2})?)?)?$');

CREATE OR REPLACE FUNCTION validate_publication_ncm_catalog_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  catalog_code TEXT;
  entry_code TEXT;
  assignable TEXT;
  edition_status TEXT;
BEGIN
  IF NEW.official_catalog_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.code, e.official_code, e.metadata ->> 'assignable', ed.status
    INTO catalog_code, entry_code, assignable, edition_status
  FROM official_catalog_entries e
  JOIN official_catalog_editions ed ON ed.id = e.catalog_edition_id
  JOIN official_catalogs c ON c.id = ed.catalog_id
  WHERE e.id = NEW.official_catalog_entry_id;

  IF catalog_code IS DISTINCT FROM 'NCM' THEN
    RAISE EXCEPTION 'publication NCM catalog entry must belong to catalog NCM';
  END IF;

  IF length(NEW.ncm_code) = 8 THEN
    IF regexp_replace(entry_code, '[^0-9]', '', 'g') IS DISTINCT FROM NEW.ncm_code::text THEN
      RAISE EXCEPTION 'publication NCM code does not match official catalog entry';
    END IF;
  ELSE
    IF edition_status IS DISTINCT FROM 'CURRENT' OR assignable IS DISTINCT FROM 'true' OR
       left(regexp_replace(entry_code, '[^0-9]', '', 'g'), length(NEW.ncm_code)) IS DISTINCT FROM NEW.ncm_code::text THEN
      RAISE EXCEPTION 'publication NCM short prefix lacks matching current assignable descendant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_publication_ncm_catalog
BEFORE INSERT OR UPDATE OF ncm_code, official_catalog_entry_id
ON publication_ncm_mentions
FOR EACH ROW EXECUTE FUNCTION validate_publication_ncm_catalog_entry();

-- Existing append-only evidence is untouched. New detector 1.2.0 stores
-- prefix-vs-exact provenance in metadata.ncmPrefixScope, and historical
-- detector 1.1.0 scans/mentions remain available for audit.
