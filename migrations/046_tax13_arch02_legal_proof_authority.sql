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
DECLARE a public.publication_legal_scope_attestations%ROWTYPE;
DECLARE expected_digest TEXT;
BEGIN
  SELECT * INTO a FROM public.publication_legal_scope_attestations WHERE id=NEW.attestation_id;
  IF NOT FOUND OR a.publication_version_id IS DISTINCT FROM NEW.publication_version_id
    OR a.html_sha256 IS DISTINCT FROM NEW.html_sha256
    OR a.valid_as_of IS DISTINCT FROM NEW.valid_as_of
    OR a.recheck_on IS DISTINCT FROM NEW.recheck_on
    OR a.coverage <> 'COMPLETE'
    OR NEW.current_fragments_sha256 IS DISTINCT FROM encode(
      sha256(convert_to(NEW.current_fragments::text,'UTF8')),'hex')
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
DECLARE scan_ public.publication_ncm_scan_evidence%ROWTYPE;
DECLARE proof_ public.tax13_legal_proofs_v2%ROWTYPE;
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
CROSS JOIN d
WHERE proof.attestation_id=p_attestation
 AND proof.valid_as_of=d.day AND proof.recheck_on>d.day
 AND a.coverage='COMPLETE' AND a.official_url=po.official_url
 AND a.source_id=po.source_id AND po.publication_id=pv.publication_id
 AND a.html_sha256=encode(sha256(convert_to(
   pv.source_metadata->'presentation'->>'html','UTF8')),'hex')
 AND pv.is_current AND public.publication_scope_is_in_scope(pv.publication_id)
 AND a.id=public.tax13_effective_attestation_id(pv.id,d.day)
 AND NOT EXISTS(SELECT 1 FROM public.tax13_legal_proof_revocations_v2 revoked
   WHERE revoked.proof_id=proof.id)
LIMIT 1 $$;
REVOKE ALL ON FUNCTION public.tax13_arch02_append_only(),
 public.tax13_validate_v2_proof_admission(), public.tax13_validate_v2_scan_seal(),
 public.tax13_v2_admitted_current_fragments(UUID) FROM PUBLIC;
-- No GRANT to radar_app or radar_worker until reviewed and proven in R8.
