-- TAX13-R2-BLOCK-02 / 045 — immutable, attestation-bound NCM scan evidence.
-- Keeps migration 028 and publication_ncm_mentions untouched as historical
-- catalog mentions. Never run against production without explicit rollout gate.
-- Deliberately NO FK to canonical publication_versions: DOE-SP rebuild safety.

CREATE TABLE public.publication_ncm_scan_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publication_version_id UUID NOT NULL,
    detector_key TEXT NOT NULL CHECK (btrim(detector_key) <> ''),
    detector_version TEXT NOT NULL CHECK (btrim(detector_version) <> ''),
    legal_scope_attestation_id UUID NOT NULL
        REFERENCES public.publication_legal_scope_attestations(id) ON DELETE RESTRICT,
    legal_as_of DATE NOT NULL,
    recheck_on DATE NOT NULL,
    coverage TEXT NOT NULL CHECK (coverage = 'COMPLETE'),
    html_sha256 CHAR(64) NOT NULL CHECK (html_sha256 ~ '^[a-f0-9]{64}$'),
    current_fragments_sha256 CHAR(64) NOT NULL
        CHECK (current_fragments_sha256 ~ '^[a-f0-9]{64}$'),
    catalog_edition_id UUID NOT NULL,
    catalog_sha256 CHAR(64) NOT NULL CHECK (catalog_sha256 ~ '^[a-f0-9]{64}$'),
    run_fingerprint CHAR(64) NOT NULL UNIQUE
        CHECK (run_fingerprint ~ '^[a-f0-9]{64}$'),
    source_field TEXT NOT NULL CHECK (source_field = 'CONTENT_TEXT'),
    candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
    match_count INTEGER NOT NULL CHECK (match_count >= 0 AND match_count <= candidate_count),
    outcome TEXT NOT NULL CHECK (outcome = 'SUCCESS'),
    supersedes_scan_id UUID
        REFERENCES public.publication_ncm_scan_evidence(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_tax13_ncm_reference_window CHECK (recheck_on > legal_as_of),
    CONSTRAINT chk_tax13_ncm_no_self_supersession
        CHECK (supersedes_scan_id IS NULL OR supersedes_scan_id <> id)
);
CREATE INDEX ix_tax13_ncm_scan_version_date
ON public.publication_ncm_scan_evidence
(publication_version_id, detector_key, detector_version, legal_as_of DESC, created_at DESC);

CREATE TABLE public.publication_ncm_scan_evidence_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_evidence_id UUID NOT NULL
        REFERENCES public.publication_ncm_scan_evidence(id) ON DELETE RESTRICT,
    ncm_code CHAR(8) NOT NULL CHECK (ncm_code ~ '^[0-9]{8}$'),
    catalog_entry_id UUID NOT NULL,
    fragment_index INTEGER NOT NULL CHECK (fragment_index >= 0),
    excerpt TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_tax13_ncm_scan_fragment_code
        UNIQUE (scan_evidence_id, ncm_code, fragment_index)
);
CREATE INDEX ix_tax13_ncm_scan_codes_code
ON public.publication_ncm_scan_evidence_codes(ncm_code, scan_evidence_id);

-- Both the scan header and code rows are immutable audit events. Retrying an
-- identical scan is handled by ON CONFLICT DO NOTHING (no destructive UPSERT).
CREATE FUNCTION public.tax13_ncm_scan_append_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'TAX13_NCM_SCAN_APPEND_ONLY';
END;
$$;
CREATE TRIGGER trg_tax13_ncm_scan_append_only
BEFORE UPDATE OR DELETE ON public.publication_ncm_scan_evidence
FOR EACH ROW EXECUTE FUNCTION public.tax13_ncm_scan_append_only();
CREATE TRIGGER trg_tax13_ncm_scan_codes_append_only
BEFORE UPDATE OR DELETE ON public.publication_ncm_scan_evidence_codes
FOR EACH ROW EXECUTE FUNCTION public.tax13_ncm_scan_append_only();

-- Disallow attaching a result to a different legal manifest, version, date or
-- predecessor. The official attestation itself remains admin-controlled (044).
CREATE FUNCTION public.tax13_ncm_scan_validate_provenance()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    proof public.publication_legal_scope_attestations%ROWTYPE;
    predecessor public.publication_ncm_scan_evidence%ROWTYPE;
BEGIN
    SELECT * INTO proof FROM public.publication_legal_scope_attestations
    WHERE id = NEW.legal_scope_attestation_id;
    IF NOT FOUND
       OR proof.publication_version_id <> NEW.publication_version_id
       OR proof.valid_as_of <> NEW.legal_as_of
       OR proof.recheck_on <> NEW.recheck_on
       OR proof.html_sha256 <> NEW.html_sha256
       OR proof.coverage <> NEW.coverage THEN
        RAISE EXCEPTION 'TAX13_NCM_SCAN_PROOF_MISMATCH';
    END IF;
    IF NEW.supersedes_scan_id IS NOT NULL THEN
        SELECT * INTO predecessor FROM public.publication_ncm_scan_evidence
        WHERE id = NEW.supersedes_scan_id;
        IF NOT FOUND OR predecessor.publication_version_id <> NEW.publication_version_id
           OR predecessor.detector_key <> NEW.detector_key
           OR predecessor.detector_version <> NEW.detector_version
           OR predecessor.created_at > NEW.created_at THEN
            RAISE EXCEPTION 'TAX13_NCM_SCAN_BAD_PREDECESSOR';
        END IF;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.official_catalog_editions ed
      JOIN public.official_catalogs c ON c.id=ed.catalog_id
      WHERE ed.id=NEW.catalog_edition_id AND c.code='NCM'
    ) THEN
        RAISE EXCEPTION 'TAX13_NCM_SCAN_BAD_CATALOG';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tax13_ncm_scan_provenance
BEFORE INSERT ON public.publication_ncm_scan_evidence
FOR EACH ROW EXECUTE FUNCTION public.tax13_ncm_scan_validate_provenance();

CREATE FUNCTION public.tax13_ncm_scan_code_validate()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    scan_edition UUID;
    scan_as_of DATE;
    scan_inserting_xid TEXT;
BEGIN
    SELECT catalog_edition_id, legal_as_of, xmin::text
    INTO scan_edition, scan_as_of, scan_inserting_xid
    FROM public.publication_ncm_scan_evidence WHERE id=NEW.scan_evidence_id;
    -- A header becomes sealed when its inserting transaction commits.
    -- Codes can only be written by that same transaction; no worker can
    -- append a 'new' positive code to an immutable historical success.
    IF scan_inserting_xid IS DISTINCT FROM
       (txid_current() % 4294967296)::text THEN
      RAISE EXCEPTION 'TAX13_NCM_SCAN_CODES_SEALED';
    END IF;
    IF scan_edition IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.official_catalog_entries e
      WHERE e.id=NEW.catalog_entry_id
        AND e.catalog_edition_id=scan_edition
        AND regexp_replace(e.official_code, '[^0-9]', '', 'g')=NEW.ncm_code
        AND COALESCE(e.metadata ->> 'assignable', 'false')='true'
        AND (nullif(e.metadata ->> 'normalizedValidFrom', '') IS NULL
          OR (e.metadata ->> 'normalizedValidFrom')::date <= scan_as_of)
        AND (nullif(e.metadata ->> 'normalizedValidTo', '') IS NULL
          OR (e.metadata ->> 'normalizedValidTo')::date >= scan_as_of)
    ) THEN
      RAISE EXCEPTION 'TAX13_NCM_SCAN_CODE_CATALOG_MISMATCH';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tax13_ncm_scan_code_provenance
BEFORE INSERT ON public.publication_ncm_scan_evidence_codes
FOR EACH ROW EXECUTE FUNCTION public.tax13_ncm_scan_code_validate();

ALTER TABLE public.publication_ncm_scan_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_ncm_scan_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE public.publication_ncm_scan_evidence_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_ncm_scan_evidence_codes FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.publication_ncm_scan_evidence,
    public.publication_ncm_scan_evidence_codes
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;
GRANT SELECT, INSERT ON public.publication_ncm_scan_evidence,
    public.publication_ncm_scan_evidence_codes TO radar_worker;

CREATE POLICY tax13_ncm_worker_scan_read ON public.publication_ncm_scan_evidence
FOR SELECT TO radar_worker USING (EXISTS (
    SELECT 1 FROM public.publication_versions pv
    WHERE pv.id=publication_version_id AND pv.is_current
      AND public.publication_scope_is_in_scope(pv.publication_id)
));
CREATE POLICY tax13_ncm_worker_scan_insert ON public.publication_ncm_scan_evidence
FOR INSERT TO radar_worker WITH CHECK (EXISTS (
    SELECT 1 FROM public.publication_versions pv
    WHERE pv.id=publication_version_id AND pv.is_current
      AND public.publication_scope_is_in_scope(pv.publication_id)
));
CREATE POLICY tax13_ncm_worker_code_read ON public.publication_ncm_scan_evidence_codes
FOR SELECT TO radar_worker USING (EXISTS (
    SELECT 1 FROM public.publication_ncm_scan_evidence scan
    WHERE scan.id=scan_evidence_id
));
CREATE POLICY tax13_ncm_worker_code_insert ON public.publication_ncm_scan_evidence_codes
FOR INSERT TO radar_worker WITH CHECK (EXISTS (
    SELECT 1 FROM public.publication_ncm_scan_evidence scan
    WHERE scan.id=scan_evidence_id
));

REVOKE ALL ON FUNCTION public.tax13_ncm_scan_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tax13_ncm_scan_validate_provenance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tax13_ncm_scan_code_validate() FROM PUBLIC;

-- Minimal read-only projection for existing TAX11 API routes. No SELECT on
-- either private ledger is granted to radar_app. The SECURITY DEFINER query
-- explicitly enforces current publication scope and recomputes catalog/HTML
-- integrity before releasing the exact scan fingerprint. Never returns the
-- legal manifest or authorizes visual legal-scope highlighting.
CREATE FUNCTION public.tax13_current_ncm_scan_fingerprint(p_version UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
WITH reference_day AS (
    SELECT (current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date AS d
), current_version AS (
    SELECT pv.id, pv.source_metadata -> 'presentation' ->> 'html' AS html
    FROM public.publication_versions pv
    WHERE pv.id=p_version AND pv.is_current
      AND pv.source_metadata -> 'presentation' ->> 'format'='SANITIZED_HTML'
      AND public.publication_scope_is_in_scope(pv.publication_id)
), newest_proof AS (
    SELECT a.* FROM public.publication_legal_scope_attestations a
    CROSS JOIN reference_day r
    WHERE a.publication_version_id=p_version AND a.valid_as_of=r.d
    ORDER BY a.created_at DESC, a.id DESC LIMIT 1
), current_catalog AS (
    SELECT ed.id,
      encode(sha256(convert_to(
        concat_ws(':', ed.edition_code, ed.source_sha256,
          coalesce((SELECT string_agg(
            entry.id::text || ':' || entry.official_code || ':' ||
            entry.description || ':' || entry.metadata::text,
            ';' ORDER BY entry.id
          ) FROM public.official_catalog_entries entry
          WHERE entry.catalog_edition_id=ed.id), '')), 'UTF8')), 'hex') AS checksum
    FROM public.official_catalog_editions ed
    JOIN public.official_catalogs c ON c.id=ed.catalog_id
    CROSS JOIN reference_day r
    WHERE c.code='NCM'
      AND (ed.valid_from IS NULL OR ed.valid_from<=r.d)
      AND (ed.valid_to IS NULL OR ed.valid_to>=r.d)
      AND ed.status <> 'WITHDRAWN'
    ORDER BY ed.valid_from DESC NULLS LAST, ed.created_at DESC, ed.id DESC
    LIMIT 1
)
SELECT scan.run_fingerprint::text
FROM current_version pv
CROSS JOIN reference_day r
JOIN newest_proof a ON a.publication_version_id=pv.id
JOIN current_catalog catalog ON TRUE
JOIN public.publication_ncm_scan_evidence scan
  ON scan.publication_version_id=pv.id
 AND scan.legal_scope_attestation_id=a.id
 AND scan.legal_as_of=r.d
 AND scan.recheck_on=a.recheck_on
 AND scan.html_sha256=a.html_sha256
 AND scan.coverage='COMPLETE' AND scan.outcome='SUCCESS'
 AND scan.catalog_edition_id=catalog.id
 AND scan.catalog_sha256=catalog.checksum
WHERE a.coverage='COMPLETE' AND a.recheck_on>r.d
  AND a.html_sha256=encode(sha256(convert_to(pv.html,'UTF8')),'hex')
LIMIT 1;
$$;

CREATE FUNCTION public.tax13_public_current_ncm_codes(p_version UUID)
RETURNS TABLE(ncm_code TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT DISTINCT c.ncm_code::text
    FROM public.publication_ncm_scan_evidence_codes c
    JOIN public.publication_ncm_scan_evidence scan
      ON scan.id=c.scan_evidence_id
    WHERE scan.publication_version_id=p_version
      AND scan.run_fingerprint::text=public.tax13_current_ncm_scan_fingerprint(p_version)
    ORDER BY 1;
$$;
REVOKE ALL ON FUNCTION public.tax13_current_ncm_scan_fingerprint(UUID)
  FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;
REVOKE ALL ON FUNCTION public.tax13_public_current_ncm_codes(UUID)
  FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;
GRANT EXECUTE ON FUNCTION public.tax13_current_ncm_scan_fingerprint(UUID),
  public.tax13_public_current_ncm_codes(UUID) TO radar_app, radar_worker;
