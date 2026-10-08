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
), ncm_catalog_snapshot AS (
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
JOIN ncm_catalog_snapshot catalog ON TRUE
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

-- Close the last positive-read channel: tenant matching consumes the 020
-- effective-assertions view directly. Historic curated successes remain in
-- publication_taxonomy_runs but cannot trigger NEW positive tenant matches.
-- Keep the view's column contract stable for TAX07/manual engine consumers.
CREATE OR REPLACE VIEW public.v_publication_taxonomy_effective_assertions AS
WITH assertion_state AS (
    SELECT
        a.id,
        a.run_id,
        a.taxonomy_release_id,
        a.release_concept_id,
        a.supersedes_assertion_id,
        a.assertion_status,
        a.confidence,
        a.decision_origin,
        a.reason_code,
        a.created_at,
        r.publication_version_id,
        (
            SELECT review.decision
            FROM public.publication_taxonomy_reviews review
            WHERE review.assertion_id = a.id
            ORDER BY review.created_at DESC, review.id DESC
            LIMIT 1
        ) AS latest_review_decision
    FROM public.publication_taxonomy_assertions a
    JOIN public.publication_taxonomy_runs r ON r.id = a.run_id
    WHERE r.status IN ('SUCCESS', 'PARTIAL')
      AND (
        r.engine_key NOT LIKE 'tribusca.taxonomy.%'
        OR (
          r.engine_key = 'tribusca.taxonomy.curated'
          AND r.engine_version = '2.4.0'
          AND r.config_snapshot ->> 'legalScopeFingerprint' =
             public.tax13_current_ncm_scan_fingerprint(r.publication_version_id)
          AND EXISTS (
            SELECT 1 FROM public.publication_taxonomy_scans s
            WHERE s.run_id = r.id AND s.status = 'SUCCESS'
          )
        )
      )
),
eligible AS (
    SELECT *
    FROM assertion_state
    WHERE latest_review_decision IS DISTINCT FROM 'REJECT'
      AND (assertion_status = 'CONFIRMED'
           OR latest_review_decision = 'CONFIRM')
),
superseded AS (
    SELECT DISTINCT supersedes_assertion_id AS id
    FROM eligible WHERE supersedes_assertion_id IS NOT NULL
)
SELECT
    e.id AS assertion_id,
    e.run_id,
    e.publication_version_id,
    e.taxonomy_release_id,
    e.release_concept_id,
    e.assertion_status,
    e.confidence,
    e.decision_origin,
    e.reason_code,
    e.created_at
FROM eligible e
WHERE NOT EXISTS (
    SELECT 1 FROM superseded s WHERE s.id = e.id
);


-- TAX13-R2 independent adversarial corrections B01-B04. These helpers have
-- no tenant-facing ledger access; they are invoked by the worker's constrained
-- ledger and the existing fail-closed SECURITY DEFINER positive projection.
-- Never choose a superseded head by UUID ordering. Any competing terminal
-- events for the same reference date produce NULL (ambiguous authority).
CREATE FUNCTION public.tax13_effective_attestation_id(
    p_version UUID, p_as_of DATE
) RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
    WITH terminal AS (
      SELECT a.id,a.created_at
      FROM public.publication_legal_scope_attestations a
      WHERE a.publication_version_id=p_version AND a.valid_as_of=p_as_of
        AND NOT EXISTS (
          SELECT 1 FROM public.publication_legal_scope_attestations child
          WHERE child.supersedes_attestation_id=a.id
            AND child.publication_version_id=a.publication_version_id
            AND child.valid_as_of=a.valid_as_of
        )
    ), newest AS (
      SELECT id FROM terminal
      WHERE created_at=(SELECT max(created_at) FROM terminal)
    )
    SELECT id FROM newest WHERE (SELECT count(*) FROM newest)=1 LIMIT 1;
$$;

-- PostgreSQL has no htmlparser2. Re-derive the legal DOM's text from the
-- persisted HTML conservatively: if its byte-decoded text differs from the
-- attestor's checked segment hashes (e.g. HTML entities, ambiguous tags,
-- surrogate offsets), return NULL and require a safer adapter. Never guess.
-- For the supported text-node HTML shape, validate ALL segments, coverage,
-- provenance, official origin, source allowlist and expiry before publishing
-- even one CURRENT fragment. Every row comes from the admin-only 044 ledger.
CREATE FUNCTION public.tax13_legal_current_fragments(p_attestation UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    record_ RECORD;
    html TEXT;
    legal_text TEXT;
    piece TEXT;
    segment JSONB;
    evidence_url TEXT;
    fragments JSONB := '[]'::jsonb;
    start_at INTEGER;
    end_at INTEGER;
    preceding INTEGER := 0;
    count_segments INTEGER := 0;
BEGIN
    SELECT a.*, pv.id AS live_version, pv.source_metadata AS live_metadata,
           pv.publication_id AS live_publication, pv.is_current AS live_current,
           po.official_url AS live_origin_url,
           po.source_id AS live_origin_source,
           po.publication_id AS live_origin_publication,
           s.code AS live_source_code
    INTO record_
    FROM public.publication_legal_scope_attestations a
    JOIN public.publication_versions pv ON pv.id=a.publication_version_id
    JOIN public.publication_origins po ON po.id=a.publication_origin_id
    JOIN public.sources s ON s.id=a.source_id
    WHERE a.id=p_attestation;
    IF NOT FOUND OR NOT record_.live_current
      OR NOT public.publication_scope_is_in_scope(record_.live_publication)
      OR record_.live_publication IS DISTINCT FROM record_.live_origin_publication
      OR record_.live_origin_source IS DISTINCT FROM record_.source_id
      OR record_.live_origin_url IS DISTINCT FROM record_.official_url
      OR record_.live_source_code <> 'confaz'
      OR record_.official_url !~ '^https://www[.]confaz[.]fazenda[.]gov[.]br($|[/?#])'
      OR record_.coverage <> 'COMPLETE'
      OR record_.recheck_on <= record_.valid_as_of
      OR record_.verified_at > statement_timestamp()
      OR record_.attestor_kind NOT IN ('OFFICIAL_ADAPTER','HUMAN_REVIEW')
      OR record_.manifest->>'version' IS DISTINCT FROM '1'
      OR record_.manifest->>'publicationVersionId' IS DISTINCT FROM record_.publication_version_id::text
      OR record_.manifest->>'sourceId' IS DISTINCT FROM record_.source_id::text
      OR record_.manifest->>'officialUrl' IS DISTINCT FROM record_.official_url
      OR record_.manifest->>'htmlSha256' IS DISTINCT FROM record_.html_sha256
      OR record_.manifest->>'validAsOf' IS DISTINCT FROM to_char(record_.valid_as_of,'YYYY-MM-DD')
      OR record_.manifest->>'recheckOn' IS DISTINCT FROM to_char(record_.recheck_on,'YYYY-MM-DD')
      OR record_.manifest->>'coverage' IS DISTINCT FROM record_.coverage
      OR record_.manifest->>'verifiedAt' IS DISTINCT FROM
          to_char(record_.verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR record_.live_metadata->'presentation'->>'format' IS DISTINCT FROM 'SANITIZED_HTML'
      OR jsonb_typeof(record_.manifest->'segments') IS DISTINCT FROM 'array'
    THEN
      RETURN NULL;
    END IF;
    html := record_.live_metadata->'presentation'->>'html';
    IF html IS NULL OR record_.html_sha256 IS DISTINCT FROM
        encode(sha256(convert_to(html,'UTF8')),'hex') THEN RETURN NULL;
    END IF;
    legal_text := regexp_replace(html,'<[^>]*>','','g');
    -- Un-decoded entities or structurally ambiguous markup are NOT silently
    -- treated as CURRENT; SHA checks on every legal segment reject divergence.
    FOR segment IN SELECT value FROM jsonb_array_elements(record_.manifest->'segments')
    LOOP
      IF segment->>'start' !~ '^[0-9]+$' OR segment->>'end' !~ '^[0-9]+$'
        OR segment->>'textSha256' !~ '^[a-f0-9]{64}$'
      THEN RETURN NULL;
      END IF;
      start_at := (segment->>'start')::integer;
      end_at := (segment->>'end')::integer;
      IF start_at < preceding OR end_at <= start_at OR end_at > char_length(legal_text)
        OR btrim(substr(legal_text,preceding+1,start_at-preceding)) <> ''
      THEN RETURN NULL;
      END IF;
      piece := substr(legal_text,start_at+1,end_at-start_at);
      IF encode(sha256(convert_to(piece,'UTF8')),'hex') IS DISTINCT FROM
           segment->>'textSha256'
        OR segment->>'status' NOT IN
           ('CURRENT','PREVIOUS','REVOKED','EDITORIAL','UNVERIFIED')
      THEN RETURN NULL;
      END IF;
      -- The worker checks URLs for every status, not only CURRENT.
      -- Source-admin evidence cannot authorize a foreign or non-HTTPS host.
      IF jsonb_typeof(segment->'evidenceUrls') IS DISTINCT FROM 'array'
        OR jsonb_array_length(segment->'evidenceUrls')>25
        OR (segment ? 'supportingActs' AND
          (jsonb_typeof(segment->'supportingActs') IS DISTINCT FROM 'array'
           OR jsonb_array_length(segment->'supportingActs')>25))
      THEN RETURN NULL; END IF;
      FOR evidence_url IN SELECT value
        FROM jsonb_array_elements_text(segment->'evidenceUrls') AS e(value)
      LOOP
        IF evidence_url !~ '^https://www[.]confaz[.]fazenda[.]gov[.]br($|[/?#])'
        THEN RETURN NULL; END IF;
      END LOOP;
      IF segment->>'status'='CURRENT' THEN
        IF segment->>'method' NOT IN ('OFFICIAL_CONSOLIDATION','OFFICIAL_AMENDMENT')
          OR jsonb_typeof(segment->'evidenceUrls') IS DISTINCT FROM 'array'
          OR jsonb_array_length(segment->'evidenceUrls')=0
        THEN RETURN NULL;
        END IF;
        fragments := fragments || jsonb_build_array(piece);
      END IF;
      preceding := end_at;
      count_segments := count_segments+1;
      IF count_segments>50000 THEN RETURN NULL; END IF;
    END LOOP;
    IF btrim(substr(legal_text,preceding+1)) <> '' THEN RETURN NULL; END IF;
    RETURN fragments;
EXCEPTION WHEN data_exception OR invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN NULL;
END;
$$;

CREATE FUNCTION public.tax13_ncm_detect_codes(p_fragment TEXT)
RETURNS TABLE(code TEXT) LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$
    SELECT DISTINCT regexp_replace((hit.capture)[1], '[^0-9]', '', 'g')
    FROM regexp_matches(p_fragment,
      '(?<![0-9.])([0-9]{8}|[0-9]{4}[.][0-9]{2}[.][0-9]{2}|[0-9]{4}[.][0-9]{4})(?![0-9]|[.][0-9])',
      'g') AS hit(capture);
$$;

CREATE FUNCTION public.tax13_ncm_scan_consistent(p_scan UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    record_ public.publication_ncm_scan_evidence%ROWTYPE;
    fragments JSONB;
    serialized TEXT;
    expected_candidates INTEGER;
    expected_matches INTEGER;
    found_codes INTEGER;
    item RECORD;
    fragment TEXT;
BEGIN
    SELECT * INTO record_ FROM public.publication_ncm_scan_evidence WHERE id=p_scan;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    fragments := public.tax13_legal_current_fragments(record_.legal_scope_attestation_id);
    IF fragments IS NULL OR jsonb_array_length(fragments)=0 THEN RETURN FALSE; END IF;
    SELECT '[' || coalesce(string_agg(to_json(value)::text,',' ORDER BY ordinality),'') || ']'
    INTO serialized FROM jsonb_array_elements_text(fragments) WITH ORDINALITY AS t(value,ordinality);
    IF record_.current_fragments_sha256 IS DISTINCT FROM
         encode(sha256(convert_to(serialized,'UTF8')),'hex')
    THEN RETURN FALSE; END IF;

    WITH extracted AS (
      SELECT DISTINCT d.code
      FROM jsonb_array_elements_text(fragments) AS f(value)
      CROSS JOIN LATERAL public.tax13_ncm_detect_codes(f.value) d
    ), eligible AS (
      SELECT x.code FROM extracted x
      WHERE EXISTS (
        SELECT 1 FROM public.official_catalog_entries e
        WHERE e.catalog_edition_id=record_.catalog_edition_id
          AND regexp_replace(e.official_code,'[^0-9]','','g')=x.code
          AND coalesce(e.metadata->>'assignable','false')='true'
          AND (nullif(e.metadata->>'normalizedValidFrom','') IS NULL
            OR (e.metadata->>'normalizedValidFrom')::date<=record_.legal_as_of)
          AND (nullif(e.metadata->>'normalizedValidTo','') IS NULL
            OR (e.metadata->>'normalizedValidTo')::date>=record_.legal_as_of)
      )
    )
    SELECT (SELECT count(*) FROM extracted),(SELECT count(*) FROM eligible)
    INTO expected_candidates,expected_matches;
    SELECT count(DISTINCT ncm_code) INTO found_codes
    FROM public.publication_ncm_scan_evidence_codes WHERE scan_evidence_id=p_scan;
    IF record_.candidate_count <> expected_candidates
       OR record_.match_count <> expected_matches
       OR found_codes <> expected_matches
    THEN RETURN FALSE; END IF;
    -- A distinct-count check alone would accept omitted occurrences when the
    -- same valid NCM appears in two separate CURRENT fragments. Compare the
    -- exact set of (fragment_index, NCM) pairs, not only unique codes.
    IF EXISTS (
      WITH expected_pairs AS (
        SELECT DISTINCT (f.ordinality - 1)::integer AS fragment_index,
          extracted.code AS ncm_code
        FROM jsonb_array_elements_text(fragments) WITH ORDINALITY AS
          f(fragment, ordinality)
        CROSS JOIN LATERAL public.tax13_ncm_detect_codes(f.fragment) extracted
        WHERE EXISTS (
          SELECT 1 FROM public.official_catalog_entries e
          WHERE e.catalog_edition_id=record_.catalog_edition_id
            AND regexp_replace(e.official_code,'[^0-9]','','g')=extracted.code
            AND coalesce(e.metadata->>'assignable','false')='true'
            AND (nullif(e.metadata->>'normalizedValidFrom','') IS NULL
              OR (e.metadata->>'normalizedValidFrom')::date<=record_.legal_as_of)
            AND (nullif(e.metadata->>'normalizedValidTo','') IS NULL
              OR (e.metadata->>'normalizedValidTo')::date>=record_.legal_as_of)
        )
      ), stored_pairs AS (
        SELECT DISTINCT fragment_index, ncm_code::text AS ncm_code
        FROM public.publication_ncm_scan_evidence_codes
        WHERE scan_evidence_id=p_scan
      )
      SELECT 1
      FROM expected_pairs e
      FULL OUTER JOIN stored_pairs s
        ON s.fragment_index=e.fragment_index AND s.ncm_code=e.ncm_code
      WHERE e.ncm_code IS NULL OR s.ncm_code IS NULL
    ) THEN RETURN FALSE; END IF;
    FOR item IN SELECT * FROM public.publication_ncm_scan_evidence_codes
                WHERE scan_evidence_id=p_scan
    LOOP
       IF item.fragment_index>=jsonb_array_length(fragments) THEN RETURN FALSE; END IF;
       fragment := fragments->>item.fragment_index;
       IF NOT EXISTS (
          SELECT 1 FROM public.tax13_ncm_detect_codes(fragment) d
          WHERE d.code=item.ncm_code
       ) OR position(btrim(item.excerpt) IN
                btrim(regexp_replace(fragment,'[[:space:]]+',' ','g')))=0
          OR btrim(item.excerpt)=''
       THEN RETURN FALSE; END IF;
       IF NOT EXISTS (
          SELECT 1 FROM public.official_catalog_entries e
          WHERE e.id=item.catalog_entry_id
            AND e.catalog_edition_id=record_.catalog_edition_id
            AND regexp_replace(e.official_code,'[^0-9]','','g')=item.ncm_code
            AND coalesce(e.metadata->>'assignable','false')='true'
            AND (nullif(e.metadata->>'normalizedValidFrom','') IS NULL
              OR (e.metadata->>'normalizedValidFrom')::date<=record_.legal_as_of)
            AND (nullif(e.metadata->>'normalizedValidTo','') IS NULL
              OR (e.metadata->>'normalizedValidTo')::date>=record_.legal_as_of)
       ) THEN RETURN FALSE; END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

-- Unlike a regular INSERT trigger, a deferred constraint trigger sees the
-- entire transaction's header+codes at COMMIT. No incomplete SUCCESS seal can
-- become permanently idempotent and suppress an unscanned NCM.
CREATE FUNCTION public.tax13_ncm_scan_seal_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NOT public.tax13_ncm_scan_consistent(NEW.id) THEN
       RAISE EXCEPTION 'TAX13_NCM_SCAN_INCOMPLETE_OR_UNVERIFIED';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_tax13_ncm_scan_complete_at_commit
AFTER INSERT ON public.publication_ncm_scan_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.tax13_ncm_scan_seal_complete();

-- A compromised/malformed worker write must be rejected immediately too,
-- even when its header was otherwise entirely well-formed.
CREATE OR REPLACE FUNCTION public.tax13_ncm_scan_code_validate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    record_ public.publication_ncm_scan_evidence%ROWTYPE;
    header_xmin TEXT;
    fragments JSONB;
    fragment TEXT;
BEGIN
    SELECT scan.xmin::text INTO header_xmin
    FROM public.publication_ncm_scan_evidence scan
    WHERE scan.id=NEW.scan_evidence_id;
    IF NOT FOUND OR header_xmin IS DISTINCT FROM
       (txid_current() % 4294967296)::text THEN
       RAISE EXCEPTION 'TAX13_NCM_SCAN_CODES_SEALED';
    END IF;
    SELECT * INTO record_ FROM public.publication_ncm_scan_evidence
    WHERE id=NEW.scan_evidence_id;
    fragments := public.tax13_legal_current_fragments(record_.legal_scope_attestation_id);
    IF fragments IS NULL OR NEW.fragment_index>=jsonb_array_length(fragments) THEN
       RAISE EXCEPTION 'TAX13_NCM_SCAN_CODE_NOT_IN_CURRENT_FRAGMENT';
    END IF;
    fragment := fragments->>NEW.fragment_index;
    IF btrim(NEW.excerpt)='' OR position(btrim(NEW.excerpt) IN
        btrim(regexp_replace(fragment,'[[:space:]]+',' ','g')))=0
       OR NOT EXISTS (
           SELECT 1 FROM public.tax13_ncm_detect_codes(fragment) d
           WHERE d.code=NEW.ncm_code
       )
       OR NOT EXISTS (
           SELECT 1 FROM public.official_catalog_entries e
           WHERE e.id=NEW.catalog_entry_id
             AND e.catalog_edition_id=record_.catalog_edition_id
             AND regexp_replace(e.official_code,'[^0-9]','','g')=NEW.ncm_code
             AND coalesce(e.metadata->>'assignable','false')='true'
             AND (nullif(e.metadata->>'normalizedValidFrom','') IS NULL
               OR (e.metadata->>'normalizedValidFrom')::date<=record_.legal_as_of)
             AND (nullif(e.metadata->>'normalizedValidTo','') IS NULL
               OR (e.metadata->>'normalizedValidTo')::date>=record_.legal_as_of)
       )
    THEN
       RAISE EXCEPTION 'TAX13_NCM_SCAN_CODE_NOT_IN_CURRENT_FRAGMENT';
    END IF;
    RETURN NEW;
END;
$$;

-- Replace the old SQL bridge with the same provenance/fragment authority.
-- Any stale origin, competing attestation, invalid full set, or catalog drift
-- returns NULL rather than a positive NCM or an invented SUCCESS(0).
CREATE OR REPLACE FUNCTION public.tax13_current_ncm_scan_fingerprint(p_version UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
WITH reference_day AS (
  SELECT (current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date d
), current_version AS (
  SELECT pv.id,pv.source_metadata->'presentation'->>'html' AS html
  FROM public.publication_versions pv
  WHERE pv.id=p_version AND pv.is_current
    AND pv.source_metadata->'presentation'->>'format'='SANITIZED_HTML'
    AND public.publication_scope_is_in_scope(pv.publication_id)
), effective_proof AS (
  SELECT a.* FROM public.publication_legal_scope_attestations a
  CROSS JOIN reference_day r
  WHERE a.id=public.tax13_effective_attestation_id(p_version,r.d)
), current_catalog AS (
  SELECT ed.id,
    encode(sha256(convert_to(
      concat_ws(':',ed.edition_code,ed.source_sha256,
        coalesce((SELECT string_agg(
          e.id::text || ':' || e.official_code || ':' || e.description || ':' || e.metadata::text,
          ';' ORDER BY e.id)
        FROM public.official_catalog_entries e
        WHERE e.catalog_edition_id=ed.id),'')), 'UTF8')),'hex') checksum
  FROM public.official_catalog_editions ed
  JOIN public.official_catalogs c ON c.id=ed.catalog_id
  CROSS JOIN reference_day r
  WHERE c.code='NCM'
    AND (ed.valid_from IS NULL OR ed.valid_from<=r.d)
    AND (ed.valid_to IS NULL OR ed.valid_to>=r.d)
    AND ed.status<>'WITHDRAWN'
  ORDER BY ed.valid_from DESC NULLS LAST,ed.created_at DESC,ed.id DESC LIMIT 1
)
SELECT scan.run_fingerprint::text
FROM current_version pv
CROSS JOIN reference_day r
JOIN effective_proof a ON a.publication_version_id=pv.id
JOIN current_catalog cat ON TRUE
JOIN public.publication_ncm_scan_evidence scan
  ON scan.publication_version_id=pv.id
  AND scan.legal_scope_attestation_id=a.id
  AND scan.detector_key='ncm.catalog.regex'
  AND scan.detector_version='1.3.0'
  AND scan.source_field='CONTENT_TEXT'
  AND scan.legal_as_of=r.d
  AND scan.recheck_on=a.recheck_on
  AND scan.html_sha256=a.html_sha256
  AND scan.coverage='COMPLETE' AND scan.outcome='SUCCESS'
  AND scan.catalog_edition_id=cat.id AND scan.catalog_sha256=cat.checksum
WHERE a.coverage='COMPLETE' AND a.recheck_on>r.d
  AND a.html_sha256=encode(sha256(convert_to(pv.html,'UTF8')),'hex')
  AND public.tax13_ncm_scan_consistent(scan.id)
LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.tax13_effective_attestation_id(UUID,DATE),
  public.tax13_legal_current_fragments(UUID),
  public.tax13_ncm_detect_codes(TEXT),
  public.tax13_ncm_scan_consistent(UUID),
  public.tax13_ncm_scan_seal_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tax13_effective_attestation_id(UUID,DATE),
  public.tax13_ncm_scan_consistent(UUID) TO radar_worker;


-- Only wording verified under the same current temporal scan may influence
-- tenant affinity. This is deliberately a read projection, not an annotation
-- license; absent/partial/stale proof returns NULL (never content_text).
CREATE FUNCTION public.tax13_public_current_legal_text(p_version UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
WITH proof AS (
  SELECT public.tax13_effective_attestation_id(
     p_version,(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date
  ) id
  WHERE public.tax13_current_ncm_scan_fingerprint(p_version) IS NOT NULL
), fragments AS (
  SELECT public.tax13_legal_current_fragments(proof.id) data
  FROM proof
)
SELECT string_agg(f.value,E'\n' ORDER BY f.ordinality)
FROM fragments CROSS JOIN LATERAL jsonb_array_elements_text(fragments.data)
  WITH ORDINALITY AS f(value,ordinality);
$$;
REVOKE ALL ON FUNCTION public.tax13_public_current_legal_text(UUID)
FROM PUBLIC, radar_worker, radar_taxonomy_curator;
GRANT EXECUTE ON FUNCTION public.tax13_public_current_legal_text(UUID)
TO radar_app;
