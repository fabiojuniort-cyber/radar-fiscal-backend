-- TAX13-R8-01/R8-02 disposable engineering migration, NOT FOR PRODUCTION.
-- Evidence-bound acceptance requires a third independent verifier credential
-- AND a database-checked verifier MAC, which issuer+sealer cannot forge.
-- PostgreSQL does not natively verify Ed25519; a distinct Node verifier
-- verifies it and the captured original, then authenticates the result with
-- a separately provisioned HMAC secret checked by pgcrypto INSIDE PostgreSQL.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='radar_proof_verifier') THEN
  CREATE ROLE radar_proof_verifier NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
ALTER ROLE radar_proof_verifier NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO radar_proof_verifier;
DO $$
DECLARE role_name TEXT;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['radar_app_runtime','radar_worker_runtime',
  'radar_legal_issuer_runtime','radar_scan_sealer_runtime',
  'radar_taxonomy_curator_runtime']
 LOOP
   IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
     EXECUTE format('REVOKE radar_proof_verifier FROM %I',role_name);
   END IF;
 END LOOP;
END $$;

-- Raw original HTTP payload is stored intact, cannot be inferred from the
-- user-provided CONFAZ XML body HTML. Collector must supply authenticated
-- source provenance and HTTP bytes separately; no data = NO positive CURRENT.
CREATE TABLE public.tax13_v2_original_http_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_version_id UUID NOT NULL,
  official_url TEXT NOT NULL CHECK (official_url ~ '^https://www[.]confaz[.]fazenda[.]gov[.]br/'),
  http_status INTEGER NOT NULL CHECK (http_status=200),
  raw_http_bytes BYTEA NOT NULL CHECK (octet_length(raw_http_bytes) BETWEEN 1 AND 16777216),
  raw_sha256 CHAR(64) NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
  sanitized_html_sha256 CHAR(64) NOT NULL CHECK (sanitized_html_sha256 ~ '^[a-f0-9]{64}$'),
  collected_at TIMESTAMPTZ NOT NULL,
  collector_identity TEXT NOT NULL CHECK (length(collector_identity) BETWEEN 5 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE(publication_version_id,official_url,raw_sha256),
  CHECK(raw_sha256=encode(sha256(raw_http_bytes),'hex'))
);
-- No direct FK from the separate source-capture ledger to publication_versions:
-- DOE-SP protected reconstruction must not gain an undeclared FK edge.
-- A constraint trigger checks the binding instead, without letting rebuild
-- cascade through this independent append-only external evidence ledger.
CREATE FUNCTION public.tax13_v2_original_http_identity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM public.publication_versions pv
   JOIN public.publication_origins po ON po.publication_id=pv.publication_id
     AND po.official_url=NEW.official_url
   JOIN public.sources src ON src.id=po.source_id AND src.code='confaz'
   WHERE pv.id=NEW.publication_version_id
     AND pv.source_metadata->'presentation'->>'format'='SANITIZED_HTML'
     AND NEW.sanitized_html_sha256=encode(sha256(convert_to(
       pv.source_metadata->'presentation'->>'html','UTF8')),'hex')
 ) THEN
   RAISE EXCEPTION 'TAX13_R8_ORIGINAL_HTTP_IDENTITY_MISMATCH';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_tax13_original_http_identity_guard
 BEFORE INSERT ON public.tax13_v2_original_http_artifacts
 FOR EACH ROW EXECUTE FUNCTION public.tax13_v2_original_http_identity_guard();
REVOKE ALL ON FUNCTION public.tax13_v2_original_http_identity_guard()
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,
 radar_legal_issuer,radar_scan_sealer,radar_proof_verifier;

CREATE TRIGGER trg_tax13_original_http_immutable
 BEFORE UPDATE OR DELETE ON public.tax13_v2_original_http_artifacts
 FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
REVOKE ALL ON public.tax13_v2_original_http_artifacts FROM PUBLIC,
 radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer,
 radar_scan_sealer,radar_proof_verifier;

-- The verifier MAC secret is inserted OUT OF BAND by an authorized DB
-- administrator; it must never appear in the migration or repo.
CREATE TABLE public.tax13_v2_verifier_mac_keys (
  key_id TEXT PRIMARY KEY,
  key_bytes BYTEA NOT NULL CHECK (octet_length(key_bytes)>=32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE public.tax13_v2_verifier_key_revocations (
  verifier_key_id TEXT PRIMARY KEY REFERENCES public.tax13_v2_verifier_mac_keys(key_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE TRIGGER trg_tax13_verifier_key_immutable
 BEFORE UPDATE OR DELETE ON public.tax13_v2_verifier_mac_keys
 FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
CREATE TRIGGER trg_tax13_verifier_key_revocation_immutable
 BEFORE UPDATE OR DELETE ON public.tax13_v2_verifier_key_revocations
 FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
REVOKE ALL ON public.tax13_v2_verifier_mac_keys,public.tax13_v2_verifier_key_revocations
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,
 radar_legal_issuer,radar_scan_sealer,radar_proof_verifier;

CREATE TABLE public.tax13_v2_verified_proofs (
 proof_id UUID PRIMARY KEY REFERENCES public.tax13_legal_proofs_v2(id) ON DELETE RESTRICT,
 artifact_id UUID NOT NULL REFERENCES public.tax13_v2_original_http_artifacts(id) ON DELETE RESTRICT,
 payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
 verifier_key_id TEXT NOT NULL REFERENCES public.tax13_v2_verifier_mac_keys(key_id) ON DELETE RESTRICT,
 verifier_mac CHAR(64) NOT NULL CHECK (verifier_mac ~ '^[a-f0-9]{64}$'),
 verifier_identity TEXT NOT NULL CHECK (length(verifier_identity) BETWEEN 5 AND 256),
 verified_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE TRIGGER trg_tax13_verified_proofs_immutable
 BEFORE UPDATE OR DELETE ON public.tax13_v2_verified_proofs
 FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
ALTER TABLE public.tax13_v2_verified_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_v2_verified_proofs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.tax13_v2_verified_proofs
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer,radar_scan_sealer;
GRANT SELECT,INSERT ON public.tax13_v2_verified_proofs TO radar_proof_verifier;
CREATE POLICY tax13_v2_verifier_verified_proofs ON public.tax13_v2_verified_proofs
 FOR ALL TO radar_proof_verifier USING (true) WITH CHECK (true);

-- Strict admission: every verifier record must authenticate an immutable
-- proof, ORIGINAL official HTTP bytes and the precise referenced version.
-- A forged proof/seal INSERT with only issuer+sealer roles gets no MAC.
CREATE FUNCTION public.tax13_v2_verify_mac_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  proof_ public.tax13_legal_proofs_v2%ROWTYPE;
  artifact_ public.tax13_v2_original_http_artifacts%ROWTYPE;
  secret_ BYTEA;
  mac_input TEXT;
BEGIN
  SELECT * INTO proof_ FROM public.tax13_legal_proofs_v2 WHERE id=NEW.proof_id;
  SELECT * INTO artifact_ FROM public.tax13_v2_original_http_artifacts WHERE id=NEW.artifact_id;
  SELECT key_bytes INTO secret_ FROM public.tax13_v2_verifier_mac_keys WHERE key_id=NEW.verifier_key_id;
  IF proof_.id IS NULL OR artifact_.id IS NULL OR secret_ IS NULL
    OR EXISTS(SELECT 1 FROM public.tax13_v2_verifier_key_revocations r
        WHERE r.verifier_key_id=NEW.verifier_key_id)
    OR proof_.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
    OR proof_.publication_version_id IS DISTINCT FROM artifact_.publication_version_id
    OR proof_.html_sha256 IS DISTINCT FROM artifact_.sanitized_html_sha256
    OR (proof_.canonical_payload::jsonb ->> 'rawArtifactSha256') IS DISTINCT FROM btrim(artifact_.raw_sha256)
    OR (proof_.canonical_payload::jsonb ->> 'officialUrl') IS DISTINCT FROM artifact_.official_url
    OR NOT EXISTS (SELECT 1 FROM public.publication_legal_scope_attestations a
       WHERE a.id=proof_.attestation_id AND a.official_url=artifact_.official_url)
  THEN
    RAISE EXCEPTION 'TAX13_R8_UNVERIFIED_ORIGINAL_OR_KEY';
  END IF;
  mac_input := 'TRIBUSCA:TAX13:R8:PROOF_VERIFIED:1' || chr(10) ||
      proof_.id::text || ':' || btrim(proof_.payload_sha256) || ':' ||
      proof_.signature_base64 || ':' || btrim(artifact_.raw_sha256);
  IF NEW.verifier_mac IS DISTINCT FROM encode(
      public.hmac(convert_to(mac_input,'UTF8'),secret_,'sha256'),'hex') THEN
    RAISE EXCEPTION 'TAX13_R8_VERIFIER_MAC_INVALID';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_tax13_v2_verified_proof_mac
 BEFORE INSERT ON public.tax13_v2_verified_proofs
 FOR EACH ROW EXECUTE FUNCTION public.tax13_v2_verify_mac_guard();
REVOKE ALL ON FUNCTION public.tax13_v2_verify_mac_guard()
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,
 radar_legal_issuer,radar_scan_sealer,radar_proof_verifier;

-- Read-only bundle for isolated verifier. No raw key bytes, never a signer.
CREATE FUNCTION public.tax13_v2_verifier_bundle(p_proof UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
SELECT jsonb_build_object(
 'proofId',p.id, 'attestationId',p.attestation_id,
 'publicationVersionId',p.publication_version_id,
 'canonicalPayload',p.canonical_payload, 'payloadSha256',p.payload_sha256,
 'signatureBase64',p.signature_base64, 'signatureKeyId',p.signature_key_id,
 'publicKeyPem',k.public_key_pem, 'rawArtifactId',a.id,
 'rawBase64',encode(a.raw_http_bytes,'base64'), 'rawSha256',a.raw_sha256,
 'officialUrl',a.official_url,'sanitizedHtml',pv.source_metadata->'presentation'->>'html',
 'manifest',att.manifest,'sourceId',att.source_id,
 'attestorKind',att.attestor_kind,'attestorRef',att.attestor_ref)
FROM public.tax13_legal_proofs_v2 p
JOIN public.publication_legal_scope_attestations att ON att.id=p.attestation_id
JOIN public.publication_versions pv ON pv.id=p.publication_version_id
JOIN public.tax13_v2_authorized_keys k ON k.key_id=p.signature_key_id
JOIN public.tax13_v2_original_http_artifacts a ON a.publication_version_id=p.publication_version_id
 AND a.official_url=att.official_url
 AND btrim(a.raw_sha256)=p.canonical_payload::jsonb->>'rawArtifactSha256'
WHERE p.id=p_proof
 AND att.coverage='COMPLETE'
 AND pv.is_current
 AND pv.source_metadata->'presentation'->>'format'='SANITIZED_HTML'
 AND public.publication_scope_is_in_scope(pv.publication_id)
 AND NOT EXISTS(SELECT 1 FROM public.tax13_v2_key_revocations r WHERE r.key_id=k.key_id)
 AND NOT EXISTS(SELECT 1 FROM public.tax13_legal_proof_revocations_v2 r WHERE r.proof_id=p.id)
LIMIT 1 $$;
REVOKE ALL ON FUNCTION public.tax13_v2_verifier_bundle(UUID)
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer,radar_scan_sealer;
GRANT EXECUTE ON FUNCTION public.tax13_v2_verifier_bundle(UUID) TO radar_proof_verifier;

-- No cryptographic verification is claimed by SQL for Ed25519 itself.
-- Instead, SQL verifies the independent verifier's secret MAC at admission;
-- signer+sealer direct SQL cannot invent this third-party statement.

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
 AND EXISTS(SELECT 1 FROM public.tax13_v2_verified_proofs vp
    WHERE vp.proof_id=proof.id AND vp.payload_sha256=proof.payload_sha256
      AND NOT EXISTS(SELECT 1 FROM public.tax13_v2_verifier_key_revocations kr
        WHERE kr.verifier_key_id=vp.verifier_key_id))
 AND NOT EXISTS(SELECT 1 FROM public.tax13_legal_proof_revocations_v2 revoked
   WHERE revoked.proof_id=proof.id)
LIMIT 1 $$;

CREATE OR REPLACE FUNCTION public.tax13_current_ncm_scan_fingerprint(p_version UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  WITH raw AS (
    SELECT public.tax13_unsealed_ncm_scan_fingerprint(p_version) AS fingerprint
  ), active_date AS (
    SELECT (current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date AS reference_day
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
    AND scan.legal_as_of=d.reference_day
    AND proof.valid_as_of=d.reference_day AND proof.recheck_on>d.reference_day
    AND public.tax13_v2_admitted_current_fragments(proof.attestation_id) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.tax13_legal_proof_revocations_v2 r
      WHERE r.proof_id=proof.id)
  LIMIT 1
$$;
-- Revoke any accidental inherited access to the verifier ledger.
REVOKE ALL ON public.tax13_v2_verified_proofs FROM radar_legal_issuer,radar_scan_sealer;

-- Independent raw-source identity is mandatory EVEN before signing V2.
-- Only the issuer role may probe existence; no raw bytes are disclosed.
CREATE FUNCTION public.tax13_v2_original_exists_for_issuer(p_attestation UUID,p_raw_sha TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
SELECT EXISTS (
 SELECT 1 FROM public.publication_legal_scope_attestations att
 JOIN public.publication_versions pv ON pv.id=att.publication_version_id
 JOIN public.tax13_v2_original_http_artifacts a ON a.publication_version_id=pv.id
   AND a.official_url=att.official_url
 WHERE att.id=p_attestation
   AND pv.is_current
   AND att.coverage='COMPLETE'
   AND a.raw_sha256=p_raw_sha
   AND a.sanitized_html_sha256=att.html_sha256
   AND a.sanitized_html_sha256=encode(sha256(
     convert_to(pv.source_metadata->'presentation'->>'html','UTF8')),'hex')
   AND a.collected_at<=statement_timestamp()
)
$$;
REVOKE ALL ON FUNCTION public.tax13_v2_original_exists_for_issuer(UUID,TEXT)
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_scan_sealer,
 radar_proof_verifier;
GRANT EXECUTE ON FUNCTION public.tax13_v2_original_exists_for_issuer(UUID,TEXT)
 TO radar_legal_issuer;

-- Direct issuer INSERT with a merely well-formed but unrelated raw digest
-- must fail; authorized source evidence is a hard DB precondition.
CREATE FUNCTION public.tax13_v2_proof_original_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT public.tax13_v2_original_exists_for_issuer(
   NEW.attestation_id,NEW.canonical_payload::jsonb->>'rawArtifactSha256') THEN
   RAISE EXCEPTION 'TAX13_R8_ORIGINAL_HTTP_UNVERIFIED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_tax13_v2_original_guard
 BEFORE INSERT ON public.tax13_legal_proofs_v2
 FOR EACH ROW EXECUTE FUNCTION public.tax13_v2_proof_original_guard();
REVOKE ALL ON FUNCTION public.tax13_v2_proof_original_guard()
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,
 radar_legal_issuer,radar_scan_sealer,radar_proof_verifier;
