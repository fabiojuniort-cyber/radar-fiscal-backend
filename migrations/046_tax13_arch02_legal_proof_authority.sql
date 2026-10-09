-- TAX13-ARCH-02 staging ONLY: Node legal authority / independent admission
-- Follows 044 and 045. This migration is additive and does NOT authorize
-- positive projections, legacy promotion, rescans, production or highlights.
-- It is intentionally not wired to the old unsafe SQL DOM parser yet.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='radar_legal_issuer') THEN
    CREATE ROLE radar_legal_issuer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='radar_scan_sealer') THEN
    CREATE ROLE radar_scan_sealer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE radar_legal_issuer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE radar_scan_sealer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO radar_legal_issuer, radar_scan_sealer;
-- Credentials for the issuer/sealer are provisioned separately, never in
-- app/worker runtime env. No membership granted to existing runtime logins.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='radar_app_runtime') THEN
    REVOKE radar_legal_issuer, radar_scan_sealer FROM radar_app_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='radar_worker_runtime') THEN
    REVOKE radar_legal_issuer, radar_scan_sealer FROM radar_worker_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='radar_taxonomy_curator_runtime') THEN
    REVOKE radar_legal_issuer, radar_scan_sealer FROM radar_taxonomy_curator_runtime;
  END IF;
END $$;

-- The signed canonical payload is preserved as exact UTF-8 text, independent
-- of JSONB rendering; payload digest uses DOMAIN || 0x00 || canonical bytes.
-- Cryptographic signature verification is a mandatory issuer-admission step,
-- not a claimed native PostgreSQL Ed25519 feature.
CREATE TABLE public.tax13_legal_proofs_v2 (
  id UUID PRIMARY KEY,
  attestation_id UUID NOT NULL UNIQUE
    REFERENCES public.publication_legal_scope_attestations(id) ON DELETE RESTRICT,
  publication_version_id UUID NOT NULL,
  html_sha256 CHAR(64) NOT NULL CHECK (html_sha256 ~ '^[a-f0-9]{64}$'),
  valid_as_of DATE NOT NULL,
  recheck_on DATE NOT NULL,
  current_fragments JSONB NOT NULL CHECK (jsonb_typeof(current_fragments)='array'),
  current_fragments_sha256 CHAR(64) NOT NULL
    CHECK (current_fragments_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_payload TEXT NOT NULL CHECK (octet_length(canonical_payload) <= 8388608),
  payload_sha256 CHAR(64) NOT NULL UNIQUE CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  signature_base64 TEXT NOT NULL CHECK (length(signature_base64) BETWEEN 86 AND 90),
  signature_key_id TEXT NOT NULL CHECK (length(signature_key_id) BETWEEN 1 AND 128),
  issuer_id TEXT NOT NULL CHECK (length(issuer_id) BETWEEN 1 AND 256),
  parser_version TEXT NOT NULL,
  sanitizer_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK (valid_as_of < recheck_on),
  CHECK (jsonb_array_length(current_fragments) > 0)
);
CREATE INDEX ix_tax13_legal_proof_v2_effective
  ON public.tax13_legal_proofs_v2(publication_version_id,valid_as_of,recheck_on);

CREATE TABLE public.tax13_legal_proof_revocations_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proof_id UUID NOT NULL UNIQUE REFERENCES public.tax13_legal_proofs_v2(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 5 AND 100),
  issuer_id TEXT NOT NULL CHECK (length(issuer_id) BETWEEN 1 AND 256),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE public.tax13_ncm_seals_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_evidence_id UUID NOT NULL UNIQUE
    REFERENCES public.publication_ncm_scan_evidence(id) ON DELETE RESTRICT,
  legal_proof_id UUID NOT NULL REFERENCES public.tax13_legal_proofs_v2(id) ON DELETE RESTRICT,
  scan_fingerprint CHAR(64) NOT NULL CHECK (scan_fingerprint ~ '^[a-f0-9]{64}$'),
  sealer_id TEXT NOT NULL CHECK (length(sealer_id) BETWEEN 1 AND 256),
  sealed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE FUNCTION public.tax13_arch02_append_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'TAX13_ARCH02_APPEND_ONLY';
END $$;
CREATE TRIGGER trg_tax13_proof_v2_no_mutation
  BEFORE UPDATE OR DELETE ON public.tax13_legal_proofs_v2
  FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
CREATE TRIGGER trg_tax13_proof_revocation_v2_no_mutation
  BEFORE UPDATE OR DELETE ON public.tax13_legal_proof_revocations_v2
  FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
CREATE TRIGGER trg_tax13_scan_seal_v2_no_mutation
  BEFORE UPDATE OR DELETE ON public.tax13_ncm_seals_v2
  FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();

CREATE FUNCTION public.tax13_validate_v2_proof_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  a public.publication_legal_scope_attestations%ROWTYPE;
  expected_digest TEXT;
BEGIN
  SELECT * INTO a FROM public.publication_legal_scope_attestations WHERE id=NEW.attestation_id;
  IF NOT FOUND OR a.publication_version_id IS DISTINCT FROM NEW.publication_version_id
    OR a.html_sha256 IS DISTINCT FROM NEW.html_sha256
    OR a.valid_as_of IS DISTINCT FROM NEW.valid_as_of
    OR a.recheck_on IS DISTINCT FROM NEW.recheck_on
    OR a.coverage <> 'COMPLETE'
    OR NEW.current_fragments_sha256 IS DISTINCT FROM encode(sha256(convert_to(
      '[' || coalesce((SELECT string_agg(to_json(value)::text,',' ORDER BY ordinality)
      FROM jsonb_array_elements_text(NEW.current_fragments)
      WITH ORDINALITY AS t(value,ordinality)),'') || ']', 'UTF8')),'hex')
  THEN RAISE EXCEPTION 'TAX13_V2_ADMISSION_EVIDENCE_MISMATCH';
  END IF;
  -- The issuer independently validates canonical_payload and the signature.
  -- Database verifies its exact hashed bytes and the linked stable fields.
  expected_digest := encode(sha256(
    convert_to('TRIBUSCA:TAX13:LEGAL_PROOF_V2','UTF8') ||
    decode('00','hex') || convert_to(NEW.canonical_payload,'UTF8')),'hex');
  IF NEW.payload_sha256 IS DISTINCT FROM expected_digest
    OR (NEW.canonical_payload::jsonb ->> 'contract') IS DISTINCT FROM 'TRIBUSCA_TAX13_LEGAL_PROOF_V2'
    OR (NEW.canonical_payload::jsonb ->> 'proofId') IS DISTINCT FROM NEW.id::text
    OR (NEW.canonical_payload::jsonb ->> 'attestationId') IS DISTINCT FROM NEW.attestation_id::text
    OR (NEW.canonical_payload::jsonb ->> 'publicationVersionId') IS DISTINCT FROM NEW.publication_version_id::text
    OR (NEW.canonical_payload::jsonb ->> 'sanitizedHtmlSha256') IS DISTINCT FROM btrim(NEW.html_sha256)
    OR (NEW.canonical_payload::jsonb ->> 'validAsOf') IS DISTINCT FROM NEW.valid_as_of::text
    OR (NEW.canonical_payload::jsonb ->> 'recheckOn') IS DISTINCT FROM NEW.recheck_on::text
    OR (NEW.canonical_payload::jsonb ->> 'coverage') IS DISTINCT FROM 'COMPLETE'
    OR (NEW.canonical_payload::jsonb -> 'currentFragments') IS DISTINCT FROM NEW.current_fragments
    OR (NEW.canonical_payload::jsonb ->> 'issuerId') IS DISTINCT FROM NEW.issuer_id
    OR (NEW.canonical_payload::jsonb ->> 'parserVersion') IS DISTINCT FROM NEW.parser_version
    OR (NEW.canonical_payload::jsonb ->> 'sanitizerVersion') IS DISTINCT FROM NEW.sanitizer_version
    OR (NEW.canonical_payload::jsonb ->> 'legalPolicyVersion') IS DISTINCT FROM NEW.policy_version
  THEN RAISE EXCEPTION 'TAX13_V2_ADMISSION_PAYLOAD_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tax13_v2_admission
  BEFORE INSERT ON public.tax13_legal_proofs_v2
  FOR EACH ROW EXECUTE FUNCTION public.tax13_validate_v2_proof_admission();

CREATE FUNCTION public.tax13_validate_v2_scan_seal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  scan_ public.publication_ncm_scan_evidence%ROWTYPE;
  proof_ public.tax13_legal_proofs_v2%ROWTYPE;
BEGIN
  SELECT * INTO scan_ FROM public.publication_ncm_scan_evidence
    WHERE id=NEW.scan_evidence_id;
  SELECT * INTO proof_ FROM public.tax13_legal_proofs_v2
    WHERE id=NEW.legal_proof_id;
  IF NOT FOUND OR scan_.id IS NULL OR proof_.id IS NULL
    OR scan_.legal_scope_attestation_id <> proof_.attestation_id
    OR scan_.publication_version_id <> proof_.publication_version_id
    OR scan_.html_sha256 <> proof_.html_sha256
    OR scan_.current_fragments_sha256 <> proof_.current_fragments_sha256
    OR scan_.legal_as_of <> proof_.valid_as_of
    OR scan_.run_fingerprint <> NEW.scan_fingerprint
    OR NOT public.tax13_ncm_scan_consistent(scan_.id)
  THEN RAISE EXCEPTION 'TAX13_V2_SCAN_SEAL_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tax13_v2_scan_seal
  BEFORE INSERT ON public.tax13_ncm_seals_v2
  FOR EACH ROW EXECUTE FUNCTION public.tax13_validate_v2_scan_seal();

ALTER TABLE public.tax13_legal_proofs_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_legal_proofs_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_legal_proof_revocations_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_legal_proof_revocations_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_ncm_seals_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_ncm_seals_v2 FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.tax13_legal_proofs_v2,
  public.tax13_legal_proof_revocations_v2,public.tax13_ncm_seals_v2
  FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,
       radar_legal_issuer,radar_scan_sealer;
GRANT SELECT,INSERT ON public.tax13_legal_proofs_v2 TO radar_legal_issuer;
GRANT SELECT,INSERT ON public.tax13_legal_proof_revocations_v2 TO radar_legal_issuer;
GRANT SELECT ON public.tax13_legal_proofs_v2,
  public.tax13_legal_proof_revocations_v2 TO radar_scan_sealer;
GRANT SELECT,INSERT ON public.tax13_ncm_seals_v2 TO radar_scan_sealer;
CREATE POLICY tax13_v2_issuer_proofs ON public.tax13_legal_proofs_v2
  FOR ALL TO radar_legal_issuer USING (true) WITH CHECK (true);
CREATE POLICY tax13_v2_sealer_proofs ON public.tax13_legal_proofs_v2
  FOR SELECT TO radar_scan_sealer USING (true);
CREATE POLICY tax13_v2_issuer_revocations ON public.tax13_legal_proof_revocations_v2
  FOR ALL TO radar_legal_issuer USING (true) WITH CHECK (true);
CREATE POLICY tax13_v2_sealer_revocations ON public.tax13_legal_proof_revocations_v2
  FOR SELECT TO radar_scan_sealer USING (true);
CREATE POLICY tax13_v2_sealer_scans ON public.tax13_ncm_seals_v2
  FOR ALL TO radar_scan_sealer USING (true) WITH CHECK (true);

-- Read-only V2 candidate bridge. Still NOT routed to app or NCM worker.
-- No SQL DOM parser; the Node issuer owns these exact text-node fragments.
CREATE FUNCTION public.tax13_v2_admitted_current_fragments(p_attestation UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
WITH d AS (SELECT (current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date day)
SELECT proof.current_fragments
FROM public.tax13_legal_proofs_v2 proof
JOIN public.publication_legal_scope_attestations a ON a.id=proof.attestation_id
JOIN public.publication_versions pv ON pv.id=proof.publication_version_id
JOIN public.publication_origins po ON po.id=a.publication_origin_id
JOIN public.sources src ON src.id=a.source_id
WHERE proof.attestation_id=p_attestation
 AND proof.valid_as_of=a.valid_as_of AND proof.recheck_on>proof.valid_as_of
 AND a.coverage='COMPLETE' AND src.code='confaz'
 AND a.official_url ~ '^https://www[.]confaz[.]fazenda[.]gov[.]br($|[/?#])'
 AND pv.source_metadata->'presentation'->>'format'='SANITIZED_HTML'
 AND a.official_url=po.official_url
 AND a.source_id=po.source_id AND po.publication_id=pv.publication_id
 AND a.html_sha256=encode(sha256(convert_to(
   pv.source_metadata->'presentation'->>'html','UTF8')),'hex')
 AND pv.is_current AND public.publication_scope_is_in_scope(pv.publication_id)
 AND a.id=public.tax13_effective_attestation_id(pv.id,proof.valid_as_of)
 AND NOT EXISTS(SELECT 1 FROM public.tax13_legal_proof_revocations_v2 revoked
   WHERE revoked.proof_id=proof.id)
LIMIT 1 $$;
REVOKE ALL ON FUNCTION public.tax13_arch02_append_only(),
 public.tax13_validate_v2_proof_admission(), public.tax13_validate_v2_scan_seal(),
 public.tax13_v2_admitted_current_fragments(UUID) FROM PUBLIC;
-- No GRANT to radar_app or radar_worker until reviewed and proven in R8.

-- P2-B: bind public labels and detector identity to the exact selected scan,
-- not to an unrelated catalog edition which happens to share an NCM code.
-- This remains constrained by the old fail-closed fingerprint gate until V2
-- emission/scan sealing replaces it in the final integration.
CREATE FUNCTION public.tax13_public_current_ncm_details(p_version UUID)
RETURNS TABLE (
  ncm_code TEXT, description TEXT, detector_key TEXT,
  detector_version TEXT, catalog_edition_id UUID,
  catalog_entry_id UUID, excerpt TEXT
) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT DISTINCT ON (code.ncm_code)
    code.ncm_code::text,e.description::text,scan.detector_key,
    scan.detector_version,scan.catalog_edition_id,code.catalog_entry_id,
    code.excerpt
  FROM public.publication_ncm_scan_evidence scan
  JOIN public.publication_ncm_scan_evidence_codes code
    ON code.scan_evidence_id=scan.id
  JOIN public.official_catalog_entries e
    ON e.id=code.catalog_entry_id
   AND e.catalog_edition_id=scan.catalog_edition_id
  WHERE scan.publication_version_id=p_version
    AND scan.run_fingerprint::text=public.tax13_current_ncm_scan_fingerprint(p_version)
  ORDER BY code.ncm_code,code.fragment_index,code.id
$$;
REVOKE ALL ON FUNCTION public.tax13_public_current_ncm_details(UUID)
  FROM PUBLIC,radar_worker,radar_taxonomy_curator,radar_app;
GRANT EXECUTE ON FUNCTION public.tax13_public_current_ncm_details(UUID)
  TO radar_app;

-- P1/C locale gate: drop the duplicated PostgreSQL legal parser completely
-- from active projections. The old function name and its OID remain, but its
-- body now reads Node-issued immutable fragments only. No V2 admission =>
-- NULL => no positive scan or tenant affinity. This is not just another regex.
CREATE OR REPLACE FUNCTION public.tax13_legal_current_fragments(p_attestation UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT public.tax13_v2_admitted_current_fragments(p_attestation)
$$;
REVOKE ALL ON FUNCTION public.tax13_legal_current_fragments(UUID)
  FROM PUBLIC,radar_app,radar_taxonomy_curator,radar_worker;

-- Preserve old structural consistency and catalog/temporal joins privately,
-- but require an independently issued V2 proof AND a separate scan sealer
-- before any existing API can return a positive fingerprint.
CREATE FUNCTION public.tax13_unsealed_ncm_scan_fingerprint(p_version UUID)
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
), ncm_catalog_current AS (
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
JOIN ncm_catalog_current cat ON TRUE
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
REVOKE ALL ON FUNCTION public.tax13_unsealed_ncm_scan_fingerprint(UUID)
  FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer,radar_scan_sealer;
CREATE OR REPLACE FUNCTION public.tax13_current_ncm_scan_fingerprint(p_version UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  WITH raw AS (
    SELECT public.tax13_unsealed_ncm_scan_fingerprint(p_version) AS fingerprint
  ), active_date AS (
    SELECT (current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date AS day
  )
  SELECT raw.fingerprint
  FROM raw
  JOIN public.publication_ncm_scan_evidence scan
    ON scan.run_fingerprint::text=raw.fingerprint
  JOIN public.tax13_ncm_seals_v2 seal
    ON seal.scan_evidence_id=scan.id
   AND seal.scan_fingerprint=scan.run_fingerprint
  JOIN public.tax13_legal_proofs_v2 proof
    ON proof.id=seal.legal_proof_id
   AND proof.attestation_id=scan.legal_scope_attestation_id
   AND proof.current_fragments_sha256=scan.current_fragments_sha256
  CROSS JOIN active_date d
  WHERE raw.fingerprint IS NOT NULL
    AND scan.publication_version_id=p_version
    AND scan.legal_as_of=d.day
    AND proof.valid_as_of=d.day AND proof.recheck_on>d.day
    AND NOT EXISTS (SELECT 1 FROM public.tax13_legal_proof_revocations_v2 r
      WHERE r.proof_id=proof.id)
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.tax13_current_ncm_scan_fingerprint(UUID)
  FROM PUBLIC,radar_legal_issuer,radar_scan_sealer,radar_taxonomy_curator;
GRANT EXECUTE ON FUNCTION public.tax13_current_ncm_scan_fingerprint(UUID)
  TO radar_app,radar_worker;

-- Issuer key trust anchor: admin registration is separate from runtime
-- legal issuance. Key revocation is append-only and instantly kills V2 reads.
CREATE TABLE public.tax13_v2_authorized_keys (
  key_id TEXT PRIMARY KEY CHECK (length(key_id) BETWEEN 1 AND 128),
  public_key_pem TEXT NOT NULL CHECK (length(public_key_pem) BETWEEN 80 AND 2000),
  active_from TIMESTAMPTZ NOT NULL,
  registered_by TEXT NOT NULL CHECK (length(registered_by) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE public.tax13_v2_key_revocations (
  key_id TEXT PRIMARY KEY REFERENCES public.tax13_v2_authorized_keys(key_id)
    ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 5 AND 100),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE TRIGGER trg_tax13_v2_key_no_mutation
  BEFORE UPDATE OR DELETE ON public.tax13_v2_authorized_keys
  FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
CREATE TRIGGER trg_tax13_v2_key_revocation_no_mutation
  BEFORE UPDATE OR DELETE ON public.tax13_v2_key_revocations
  FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
ALTER TABLE public.tax13_v2_authorized_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_v2_authorized_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_v2_key_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_v2_key_revocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.tax13_v2_authorized_keys, public.tax13_v2_key_revocations
  FROM PUBLIC, radar_app,radar_worker,radar_taxonomy_curator,
       radar_legal_issuer,radar_scan_sealer;

CREATE FUNCTION public.tax13_v2_issuer_key(p_key_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT k.public_key_pem FROM public.tax13_v2_authorized_keys k
 WHERE k.key_id=p_key_id AND k.active_from<=statement_timestamp()
   AND NOT EXISTS(SELECT 1 FROM public.tax13_v2_key_revocations revoked
     WHERE revoked.key_id=k.key_id)
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.tax13_v2_issuer_key(TEXT)
  FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_scan_sealer;
GRANT EXECUTE ON FUNCTION public.tax13_v2_issuer_key(TEXT) TO radar_legal_issuer;

CREATE FUNCTION public.tax13_v2_issuer_input(p_attestation UUID)
RETURNS TABLE(
  attestation_id UUID, publication_version_id UUID,
  source_id UUID, official_url TEXT,
  sanitized_html TEXT, manifest JSONB,
  attestor_ref TEXT, attestor_kind TEXT
) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT a.id, a.publication_version_id, a.source_id, a.official_url,
   pv.source_metadata->'presentation'->>'html', a.manifest,
   a.attestor_ref, a.attestor_kind
 FROM public.publication_legal_scope_attestations a
 JOIN public.publication_versions pv ON pv.id=a.publication_version_id
 JOIN public.publication_origins po ON po.id=a.publication_origin_id
 JOIN public.sources src ON src.id=a.source_id
 WHERE a.id=p_attestation
   AND pv.is_current AND public.publication_scope_is_in_scope(pv.publication_id)
   AND pv.publication_id=po.publication_id
   AND po.source_id=a.source_id AND po.official_url=a.official_url
   AND src.code='confaz'
   AND a.official_url ~ '^https://www[.]confaz[.]fazenda[.]gov[.]br($|[/?#])'
   AND pv.source_metadata->'presentation'->>'format'='SANITIZED_HTML'
   AND a.coverage='COMPLETE'
   AND a.id=public.tax13_effective_attestation_id(pv.id,a.valid_as_of)
$$;
REVOKE ALL ON FUNCTION public.tax13_v2_issuer_input(UUID)
  FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_scan_sealer;
GRANT EXECUTE ON FUNCTION public.tax13_v2_issuer_input(UUID) TO radar_legal_issuer;

CREATE FUNCTION public.tax13_v2_key_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.tax13_v2_authorized_keys k
    WHERE k.key_id=NEW.signature_key_id AND k.active_from<=statement_timestamp()
      AND NOT EXISTS(SELECT 1 FROM public.tax13_v2_key_revocations r
        WHERE r.key_id=k.key_id)
  ) THEN
    RAISE EXCEPTION 'TAX13_V2_SIGNING_KEY_NOT_AUTHORIZED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tax13_v2_key_guard
  BEFORE INSERT ON public.tax13_legal_proofs_v2
  FOR EACH ROW EXECUTE FUNCTION public.tax13_v2_key_guard();
REVOKE ALL ON FUNCTION public.tax13_v2_key_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.tax13_v2_admitted_current_fragments(p_attestation UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
SELECT proof.current_fragments
FROM public.tax13_legal_proofs_v2 proof
JOIN public.publication_legal_scope_attestations a ON a.id=proof.attestation_id
JOIN public.publication_versions pv ON pv.id=proof.publication_version_id
JOIN public.publication_origins po ON po.id=a.publication_origin_id
JOIN public.sources src ON src.id=a.source_id
WHERE proof.attestation_id=p_attestation
 AND proof.valid_as_of=a.valid_as_of AND proof.recheck_on>proof.valid_as_of
 AND a.coverage='COMPLETE' AND src.code='confaz'
 AND a.official_url ~ '^https://www[.]confaz[.]fazenda[.]gov[.]br($|[/?#])'
 AND pv.source_metadata->'presentation'->>'format'='SANITIZED_HTML'
 AND a.official_url=po.official_url
 AND a.source_id=po.source_id AND po.publication_id=pv.publication_id
 AND a.html_sha256=encode(sha256(convert_to(
   pv.source_metadata->'presentation'->>'html','UTF8')),'hex')
 AND pv.is_current AND public.publication_scope_is_in_scope(pv.publication_id)
 AND a.id=public.tax13_effective_attestation_id(pv.id,proof.valid_as_of)
 AND EXISTS(SELECT 1 FROM public.tax13_v2_authorized_keys k
   WHERE k.key_id=proof.signature_key_id AND k.active_from<=proof.created_at
     AND NOT EXISTS(SELECT 1 FROM public.tax13_v2_key_revocations r
       WHERE r.key_id=k.key_id))
 AND NOT EXISTS(SELECT 1 FROM public.tax13_legal_proof_revocations_v2 revoked
   WHERE revoked.proof_id=proof.id)
LIMIT 1 $$;
REVOKE ALL ON FUNCTION public.tax13_v2_admitted_current_fragments(UUID)
  FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_scan_sealer;

-- Narrow SECURITY DEFINER read boundary for a separate NCM sealer process.
-- No direct SELECT on immutable scan or private certificate given to app.
CREATE FUNCTION public.tax13_v2_sealer_bundle(p_scan UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
   'scanId', scan.id,
   'runFingerprint', scan.run_fingerprint,
   'attestationId', scan.legal_scope_attestation_id,
   'publicationVersionId', scan.publication_version_id,
   'detectorKey', scan.detector_key,
   'detectorVersion', scan.detector_version,
   'legalAsOf', scan.legal_as_of,
   'recheckOn', scan.recheck_on,
   'htmlSha256', scan.html_sha256,
   'fragmentsSha256', scan.current_fragments_sha256,
   'catalogEditionId', scan.catalog_edition_id,
   'catalogSha256', scan.catalog_sha256,
   'candidateCount', scan.candidate_count,
   'matchCount', scan.match_count,
   'proofId', proof.id,
   'payloadCanonical', proof.canonical_payload,
   'payloadSha256', proof.payload_sha256,
   'signatureBase64', proof.signature_base64,
   'signatureKeyId', proof.signature_key_id,
   'signingPublicKeyPem', key_.public_key_pem,
   'legalManifest', a.manifest,
   'sanitizedHtml', pv.source_metadata->'presentation'->>'html',
   'sourceId', a.source_id,
   'officialUrl', a.official_url,
   'codes',coalesce((
     SELECT jsonb_agg(jsonb_build_object(
       'code',c.ncm_code,
       'fragmentIndex',c.fragment_index,
       'catalogEntryId',c.catalog_entry_id,
       'excerpt',c.excerpt)
       ORDER BY c.fragment_index,c.ncm_code)
     FROM public.publication_ncm_scan_evidence_codes c
     WHERE c.scan_evidence_id=scan.id
   ),'[]'::jsonb))
 FROM public.publication_ncm_scan_evidence scan
 JOIN public.tax13_legal_proofs_v2 proof
   ON proof.attestation_id=scan.legal_scope_attestation_id
   AND proof.publication_version_id=scan.publication_version_id
   AND proof.current_fragments_sha256=scan.current_fragments_sha256
 JOIN public.tax13_v2_authorized_keys key_
   ON key_.key_id=proof.signature_key_id
 JOIN public.publication_legal_scope_attestations a
   ON a.id=scan.legal_scope_attestation_id
 JOIN public.publication_versions pv
   ON pv.id=scan.publication_version_id
 WHERE scan.id=p_scan AND scan.outcome='SUCCESS'
   AND scan.coverage='COMPLETE'
   AND key_.active_from<=proof.created_at
   AND NOT EXISTS(SELECT 1 FROM public.tax13_v2_key_revocations r
     WHERE r.key_id=key_.key_id)
   AND NOT EXISTS(SELECT 1 FROM public.tax13_legal_proof_revocations_v2 r
     WHERE r.proof_id=proof.id)
   AND public.tax13_v2_admitted_current_fragments(scan.legal_scope_attestation_id) IS NOT NULL
   AND public.tax13_ncm_scan_consistent(scan.id)
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.tax13_v2_sealer_bundle(UUID)
  FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer;
GRANT EXECUTE ON FUNCTION public.tax13_v2_sealer_bundle(UUID) TO radar_scan_sealer;

-- Worker may test an exact scan's independent seal, but cannot read/write
-- the private seal table or turn an unsupported 044 event into CURRENT.
CREATE FUNCTION public.tax13_v2_is_scan_sealed(p_scan UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.publication_ncm_scan_evidence scan
    JOIN public.tax13_ncm_seals_v2 seal ON seal.scan_evidence_id=scan.id
      AND seal.scan_fingerprint=scan.run_fingerprint
    JOIN public.tax13_legal_proofs_v2 proof ON proof.id=seal.legal_proof_id
      AND proof.attestation_id=scan.legal_scope_attestation_id
      AND proof.publication_version_id=scan.publication_version_id
      AND proof.current_fragments_sha256=scan.current_fragments_sha256
    JOIN public.tax13_v2_authorized_keys k ON k.key_id=proof.signature_key_id
    WHERE scan.id=p_scan
      AND scan.outcome='SUCCESS' AND scan.coverage='COMPLETE'
      AND proof.valid_as_of=scan.legal_as_of AND proof.recheck_on=scan.recheck_on
      AND k.active_from<=proof.created_at
      AND public.tax13_v2_admitted_current_fragments(proof.attestation_id) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.tax13_v2_key_revocations r WHERE r.key_id=k.key_id)
      AND NOT EXISTS(SELECT 1 FROM public.tax13_legal_proof_revocations_v2 r WHERE r.proof_id=proof.id)
  )
$$;
REVOKE ALL ON FUNCTION public.tax13_v2_is_scan_sealed(UUID)
 FROM PUBLIC,radar_app,radar_taxonomy_curator,radar_legal_issuer,radar_scan_sealer;
GRANT EXECUTE ON FUNCTION public.tax13_v2_is_scan_sealed(UUID) TO radar_worker;
