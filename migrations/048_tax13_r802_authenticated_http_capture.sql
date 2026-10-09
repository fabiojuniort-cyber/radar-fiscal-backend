-- TAX13-R8-02 isolated, pending independent R9. NEVER deploy to production.
-- An administrator-inserted original HTTP artifact, even with a valid digest,
-- is NOT evidence of an official HTTPS fetch. This new independent collector
-- attests the live network transaction with a secret not held by issuer,
-- proof-verifier, scan-sealer, worker, curator or app. Fail closed on absence.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='radar_http_collector') THEN
  CREATE ROLE radar_http_collector NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
ALTER ROLE radar_http_collector NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO radar_http_collector;
DO $$
DECLARE n TEXT;
BEGIN
 FOREACH n IN ARRAY ARRAY['radar_app_runtime','radar_worker_runtime',
  'radar_taxonomy_curator_runtime','radar_legal_issuer_runtime',
  'radar_scan_sealer_runtime','radar_proof_verifier_runtime'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=n) THEN
   EXECUTE format('REVOKE radar_http_collector FROM %I',n);
  END IF;
 END LOOP;
END $$;

-- 047 disallows repeated capture of unchanged source bytes. 048 must
-- preserve *every distinct network event* and collector receipt, even if
-- publicationVersionId and SHA remain identical across verified rechecks.
-- Replace only the specific 047 uniqueness constraint with a lookup index.
DO $$
DECLARE constraint_name text;
BEGIN
 SELECT c.conname INTO constraint_name FROM pg_constraint c
 WHERE c.conrelid='public.tax13_v2_original_http_artifacts'::regclass
  AND c.contype='u'
  AND (SELECT array_agg(a.attname ORDER BY a.attname)
       FROM unnest(c.conkey) k(attnum)
       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)
    = ARRAY['official_url','publication_version_id','raw_sha256']
 LIMIT 1;
 IF constraint_name IS NULL THEN
   RAISE EXCEPTION 'TAX13_R802_EXPECTED_047_CAPTURE_UNIQUE_NOT_FOUND';
 END IF;
 EXECUTE format('ALTER TABLE public.tax13_v2_original_http_artifacts DROP CONSTRAINT %I',constraint_name);
END $$;
CREATE INDEX ix_tax13_r802_original_capture_version_sha
 ON public.tax13_v2_original_http_artifacts
 (publication_version_id,official_url,raw_sha256,collected_at DESC);

CREATE TABLE public.tax13_v2_capture_mac_keys (
 key_id TEXT PRIMARY KEY,
 key_bytes BYTEA NOT NULL CHECK(octet_length(key_bytes)>=32),
 created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE public.tax13_v2_capture_key_revocations (
 key_id TEXT PRIMARY KEY REFERENCES public.tax13_v2_capture_mac_keys(key_id) ON DELETE RESTRICT,
 reason TEXT NOT NULL,
 revoked_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE TRIGGER trg_tax13_capture_key_append_only
 BEFORE UPDATE OR DELETE ON public.tax13_v2_capture_mac_keys
 FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
CREATE TRIGGER trg_tax13_capture_revocation_append_only
 BEFORE UPDATE OR DELETE ON public.tax13_v2_capture_key_revocations
 FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
REVOKE ALL ON public.tax13_v2_capture_mac_keys, public.tax13_v2_capture_key_revocations
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer,
 radar_scan_sealer,radar_proof_verifier,radar_http_collector;

CREATE TABLE public.tax13_v2_official_capture_receipts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 artifact_id UUID NOT NULL UNIQUE REFERENCES public.tax13_v2_original_http_artifacts(id) ON DELETE RESTRICT,
 capture_key_id TEXT NOT NULL REFERENCES public.tax13_v2_capture_mac_keys(key_id) ON DELETE RESTRICT,
 final_url TEXT NOT NULL,
 redirect_urls TEXT[] NOT NULL,
 remote_ipv4 INET NOT NULL,
 tls_peer_cert_sha256 CHAR(64) NOT NULL CHECK(tls_peer_cert_sha256 ~ '^[a-f0-9]{64}$'),
 collector_identity TEXT NOT NULL CHECK(length(collector_identity) BETWEEN 8 AND 128),
 started_at TIMESTAMPTZ NOT NULL,
 captured_at TIMESTAMPTZ NOT NULL,
 receipt_mac CHAR(64) NOT NULL CHECK(receipt_mac ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
 CONSTRAINT ck_tax13_capture_network_times CHECK(
   captured_at>=started_at AND captured_at<=started_at+INTERVAL '60 seconds')
);
CREATE TRIGGER trg_tax13_capture_receipt_append_only
 BEFORE UPDATE OR DELETE ON public.tax13_v2_official_capture_receipts
 FOR EACH ROW EXECUTE FUNCTION public.tax13_arch02_append_only();
ALTER TABLE public.tax13_v2_official_capture_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax13_v2_official_capture_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.tax13_v2_official_capture_receipts
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer,
 radar_scan_sealer,radar_proof_verifier;
GRANT SELECT,INSERT ON public.tax13_v2_official_capture_receipts TO radar_http_collector;
CREATE POLICY tax13_r802_collector_receipt ON public.tax13_v2_official_capture_receipts
 FOR ALL TO radar_http_collector USING(true) WITH CHECK(true);
-- Owner SECURITY DEFINER readers still need a SELECT policy with FORCE RLS;
-- this does NOT grant table SELECT to PUBLIC.
CREATE POLICY tax13_r802_owner_read ON public.tax13_v2_official_capture_receipts
 FOR SELECT TO PUBLIC USING(true);

-- Immutable original table existed before 048. No artificial admin fixture
-- becomes official unless a separately authenticated capture receipt exists.
GRANT SELECT,INSERT ON public.tax13_v2_original_http_artifacts TO radar_http_collector;

CREATE FUNCTION public.tax13_r802_capture_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 a public.tax13_v2_original_http_artifacts%ROWTYPE;
 secret_ BYTEA;
 payload TEXT;
BEGIN
 SELECT * INTO a FROM public.tax13_v2_original_http_artifacts WHERE id=NEW.artifact_id;
 SELECT key_bytes INTO secret_ FROM public.tax13_v2_capture_mac_keys WHERE key_id=NEW.capture_key_id;
 IF a.id IS NULL OR secret_ IS NULL
   OR EXISTS(SELECT 1 FROM public.tax13_v2_capture_key_revocations k WHERE k.key_id=NEW.capture_key_id)
   OR a.http_status<>200
   OR NEW.captured_at IS DISTINCT FROM a.collected_at
   OR NEW.captured_at > statement_timestamp() + INTERVAL '30 seconds'
   OR NEW.captured_at < statement_timestamp() - INTERVAL '120 seconds'
   OR a.created_at < statement_timestamp() - INTERVAL '120 seconds'
   OR NEW.started_at > NEW.captured_at OR NEW.started_at < NEW.captured_at - INTERVAL '60 seconds'
   OR NEW.final_url !~ '^https://www[.]confaz[.]fazenda[.]gov[.]br/legislacao/'
   OR NEW.collector_identity !~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$'
   OR coalesce(array_length(NEW.redirect_urls,1),0) NOT BETWEEN 1 AND 5
   OR NEW.redirect_urls[1] IS DISTINCT FROM a.official_url
   OR NEW.redirect_urls[array_length(NEW.redirect_urls,1)] IS DISTINCT FROM NEW.final_url
   OR EXISTS(SELECT 1 FROM unnest(NEW.redirect_urls) u
     WHERE u !~ '^https://www[.]confaz[.]fazenda[.]gov[.]br/legislacao/')
   OR NEW.remote_ipv4 << inet '0.0.0.0/8'
   OR NEW.remote_ipv4 << inet '10.0.0.0/8'
   OR NEW.remote_ipv4 << inet '127.0.0.0/8'
   OR NEW.remote_ipv4 << inet '172.16.0.0/12'
   OR NEW.remote_ipv4 << inet '192.168.0.0/16'
   OR NEW.remote_ipv4 << inet '169.254.0.0/16'
   OR NEW.remote_ipv4 << inet '100.64.0.0/10'
   OR NEW.remote_ipv4 << inet '192.0.0.0/24'
   OR NEW.remote_ipv4 << inet '192.0.2.0/24'
   OR NEW.remote_ipv4 << inet '198.18.0.0/15'
   OR NEW.remote_ipv4 << inet '198.51.100.0/24'
   OR NEW.remote_ipv4 << inet '203.0.113.0/24'
   OR NEW.remote_ipv4 << inet '224.0.0.0/4'
   OR NEW.remote_ipv4 << inet '240.0.0.0/4'
   OR family(NEW.remote_ipv4) <> 4
 THEN RAISE EXCEPTION 'TAX13_R802_CAPTURE_NOT_AUTHENTICATED'; END IF;
 payload := concat_ws(chr(10),
 'TRIBUSCA:TAX13:R802:HTTPS_CAPTURE:1',
 NEW.artifact_id::text, btrim(a.raw_sha256), a.publication_version_id::text,
 a.official_url, NEW.final_url, array_to_string(NEW.redirect_urls,chr(10)),
 NEW.remote_ipv4::text, btrim(NEW.tls_peer_cert_sha256), NEW.collector_identity,
 to_char(NEW.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 to_char(NEW.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 IF NEW.receipt_mac IS DISTINCT FROM encode(
    public.hmac(convert_to(payload,'UTF8'),secret_,'sha256'),'hex')
 THEN RAISE EXCEPTION 'TAX13_R802_CAPTURE_MAC_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_tax13_r802_capture_guard
 BEFORE INSERT ON public.tax13_v2_official_capture_receipts
 FOR EACH ROW EXECUTE FUNCTION public.tax13_r802_capture_guard();
REVOKE ALL ON FUNCTION public.tax13_r802_capture_guard()
 FROM PUBLIC,radar_app,radar_worker,radar_legal_issuer,radar_scan_sealer,
 radar_taxonomy_curator,radar_proof_verifier,radar_http_collector;

CREATE FUNCTION public.tax13_v2_capture_verified(p_artifact UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS (
 SELECT 1 FROM public.tax13_v2_official_capture_receipts r
 JOIN public.tax13_v2_original_http_artifacts a ON a.id=r.artifact_id
 WHERE a.id=p_artifact AND r.captured_at=a.collected_at
 AND a.created_at>=r.captured_at - INTERVAL '120 seconds'
 AND NOT EXISTS (SELECT 1 FROM public.tax13_v2_capture_key_revocations v
   WHERE v.key_id=r.capture_key_id)
 ) $$;
REVOKE ALL ON FUNCTION public.tax13_v2_capture_verified(UUID)
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,
 radar_legal_issuer,radar_scan_sealer,radar_proof_verifier,radar_http_collector;

-- Collector may only fetch a URL already registered against this exact
-- current CONFAZ publication/version. No generic SQL, foreign host or input
-- controlled raw payload is supplied to the collector process.
CREATE FUNCTION public.tax13_r802_capture_target(p_version UUID,p_url TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('publicationVersionId',pv.id,
  'officialUrl',po.official_url,'sanitizedHtml',
    pv.source_metadata->'presentation'->>'html')
 FROM public.publication_versions pv
 JOIN public.publication_origins po ON po.publication_id=pv.publication_id
 JOIN public.sources src ON src.id=po.source_id AND src.code='confaz'
 WHERE pv.id=p_version AND pv.is_current
   AND public.publication_scope_is_in_scope(pv.publication_id)
   AND po.official_url=p_url
   AND po.official_url ~ '^https://www[.]confaz[.]fazenda[.]gov[.]br/legislacao/'
   AND pv.source_metadata->'presentation'->>'format'='SANITIZED_HTML'
   AND length(pv.source_metadata->'presentation'->>'html')>0
 LIMIT 1 $$;
REVOKE ALL ON FUNCTION public.tax13_r802_capture_target(UUID,TEXT)
 FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator,
 radar_legal_issuer,radar_scan_sealer,radar_proof_verifier;
GRANT EXECUTE ON FUNCTION public.tax13_r802_capture_target(UUID,TEXT)
 TO radar_http_collector;

-- Independent proof verifier reads only the immutable metadata needed
-- to replay the official HTTPS URL; it never receives the collector MAC key.
CREATE FUNCTION public.tax13_r802_verifier_capture_bundle(p_artifact UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object(
   'artifactId',a.id,'rawSha256',a.raw_sha256,'requestUrl',a.official_url,
   'finalUrl',r.final_url,'redirectChain',r.redirect_urls,
   'collectorIdentity',r.collector_identity,'remoteIpv4',host(r.remote_ipv4),
   'tlsPeerCertificateSha256',r.tls_peer_cert_sha256,'collectedAt',r.captured_at)
 FROM public.tax13_v2_original_http_artifacts a
 JOIN public.tax13_v2_official_capture_receipts r ON r.artifact_id=a.id
 WHERE a.id=p_artifact AND public.tax13_v2_capture_verified(a.id)
 LIMIT 1 $$;
REVOKE ALL ON FUNCTION public.tax13_r802_verifier_capture_bundle(UUID)
 FROM PUBLIC,radar_app,radar_worker,radar_legal_issuer,
 radar_scan_sealer,radar_taxonomy_curator,radar_http_collector;
GRANT EXECUTE ON FUNCTION public.tax13_r802_verifier_capture_bundle(UUID) TO radar_proof_verifier;

-- Even a verified Ed25519 signature or a previously issued MAC cannot
-- promote a fixture without an independent live collector receipt.
CREATE OR REPLACE FUNCTION public.tax13_v2_original_exists_for_issuer(p_attestation UUID,p_raw_sha TEXT)
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
    AND public.tax13_v2_capture_verified(a.id)
)
$$;

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
      AND public.tax13_v2_capture_verified(vp.artifact_id)
      AND NOT EXISTS(SELECT 1 FROM public.tax13_v2_verifier_key_revocations kr
        WHERE kr.verifier_key_id=vp.verifier_key_id))
 AND NOT EXISTS(SELECT 1 FROM public.tax13_legal_proof_revocations_v2 revoked
   WHERE revoked.proof_id=proof.id)
LIMIT 1 $$;


CREATE FUNCTION public.tax13_r802_verified_proof_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT public.tax13_v2_capture_verified(NEW.artifact_id) THEN
   RAISE EXCEPTION 'TAX13_R802_OFFICIAL_CAPTURE_UNVERIFIED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_tax13_r802_verified_proof_guard
 BEFORE INSERT ON public.tax13_v2_verified_proofs
 FOR EACH ROW EXECUTE FUNCTION public.tax13_r802_verified_proof_guard();
REVOKE ALL ON FUNCTION public.tax13_r802_verified_proof_guard()
 FROM PUBLIC,radar_app,radar_worker,radar_legal_issuer,radar_scan_sealer,
 radar_taxonomy_curator,radar_proof_verifier,radar_http_collector;
