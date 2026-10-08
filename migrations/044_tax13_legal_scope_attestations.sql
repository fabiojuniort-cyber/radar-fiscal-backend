-- TAX13/B4 — Content-addressed, append-only legal-vigency attestations.
-- Migration 044 follows onboarding's reserved 042/043. It does not
-- depend on 042/043 objects and must not be deployed before their gate.
-- Attestation creation is an ADMIN-only, reviewed process. No connector,
-- app, curator or worker can fabricate/modify a legal status in SQL.
CREATE TABLE public.publication_legal_scope_attestations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Deliberately no physical FK from this immutable derived audit history
    -- to publication_versions or publication_origins. The DOE-SP guarded
    -- rebuild may delete/recreate canonical versions/origins, and explicitly
    -- aborts when previously unknown canonical FKs appear. The INSERT trigger
    -- verifies the references against both canonical tables instead; the
    -- worker's RLS/reader joins prevent accepting a deleted/stale version.
    publication_version_id UUID NOT NULL,
    source_id UUID NOT NULL
        REFERENCES public.sources(id) ON DELETE RESTRICT,
    publication_origin_id UUID NOT NULL,
    official_url TEXT NOT NULL
        CHECK (official_url ~ '^https://[^[:space:]]+$'),
    html_sha256 CHAR(64) NOT NULL
        CHECK (html_sha256 ~ '^[a-f0-9]{64}$'),
    valid_as_of DATE NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL,
    recheck_on DATE NOT NULL,
    coverage TEXT NOT NULL
        CHECK (coverage IN ('COMPLETE', 'PARTIAL', 'UNVERIFIED')),
    manifest JSONB NOT NULL
        CHECK (jsonb_typeof(manifest) = 'object'
               AND manifest ->> 'version' = '1'
               AND jsonb_typeof(manifest -> 'segments') = 'array'),
    attestor_kind TEXT NOT NULL
        CHECK (attestor_kind IN ('OFFICIAL_ADAPTER', 'HUMAN_REVIEW')),
    attestor_ref TEXT NOT NULL CHECK (btrim(attestor_ref) <> ''),
    supersedes_attestation_id UUID
        REFERENCES public.publication_legal_scope_attestations(id)
        ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_tax13_attestation_dates
        CHECK (recheck_on > valid_as_of AND verified_at <= created_at),
    CONSTRAINT chk_tax13_attestation_not_self
        CHECK (supersedes_attestation_id IS NULL OR supersedes_attestation_id <> id)
);

CREATE INDEX ix_tax13_legal_scope_version_reference
ON public.publication_legal_scope_attestations
(publication_version_id, valid_as_of DESC, created_at DESC, id DESC);
CREATE INDEX ix_tax13_legal_scope_source
ON public.publication_legal_scope_attestations (source_id, publication_version_id);

-- Preserve historical audits. Corrections are NEW attestation events pointing
-- back to a prior id, never UPDATE/DELETE or mutating prior snapshots.
CREATE FUNCTION public.tax13_legal_scope_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'TAX13_LEGAL_SCOPE_APPEND_ONLY';
END;
$$;

CREATE TRIGGER trg_tax13_legal_scope_append_only
BEFORE UPDATE OR DELETE ON public.publication_legal_scope_attestations
FOR EACH ROW
EXECUTE FUNCTION public.tax13_legal_scope_append_only();

-- Even admin insert cannot point to an unrelated source or previous version,
-- nor supersede another publication's attestation.
CREATE FUNCTION public.tax13_legal_scope_validate_provenance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    origin_publication UUID;
    version_publication UUID;
    origin_url TEXT;
    supersedes_version UUID;
    supersedes_source UUID;
    supersedes_origin UUID;
BEGIN
    SELECT po.publication_id, po.official_url INTO origin_publication, origin_url
    FROM public.publication_origins po
    WHERE po.id = NEW.publication_origin_id AND po.source_id = NEW.source_id;

    SELECT pv.publication_id INTO version_publication
    FROM public.publication_versions pv
    WHERE pv.id = NEW.publication_version_id;

    IF origin_publication IS NULL OR version_publication IS NULL
       OR origin_publication <> version_publication
       OR origin_url IS DISTINCT FROM NEW.official_url THEN
        RAISE EXCEPTION 'TAX13_LEGAL_SCOPE_SOURCE_VERSION_MISMATCH';
    END IF;

    -- The persisted JSON cannot claim a different version, source, origin,
    -- official URL or document hash from the audited SQL columns.
    IF NEW.manifest ->> 'publicationVersionId' IS DISTINCT FROM NEW.publication_version_id::text
       OR NEW.manifest ->> 'sourceId' IS DISTINCT FROM NEW.source_id::text
       OR NEW.manifest ->> 'officialUrl' IS DISTINCT FROM NEW.official_url
       OR NEW.manifest ->> 'htmlSha256' IS DISTINCT FROM NEW.html_sha256
       OR NEW.manifest ->> 'validAsOf' IS DISTINCT FROM to_char(NEW.valid_as_of, 'YYYY-MM-DD')
       OR NEW.manifest ->> 'recheckOn' IS DISTINCT FROM to_char(NEW.recheck_on, 'YYYY-MM-DD')
       OR NEW.manifest ->> 'coverage' IS DISTINCT FROM NEW.coverage THEN
        RAISE EXCEPTION 'TAX13_LEGAL_SCOPE_MANIFEST_MISMATCH';
    END IF;

    IF NEW.supersedes_attestation_id IS NOT NULL THEN
        SELECT a.publication_version_id, a.source_id, a.publication_origin_id
        INTO supersedes_version, supersedes_source, supersedes_origin
        FROM public.publication_legal_scope_attestations a
        WHERE a.id = NEW.supersedes_attestation_id;
        IF supersedes_version IS DISTINCT FROM NEW.publication_version_id
           OR supersedes_source IS DISTINCT FROM NEW.source_id
           OR supersedes_origin IS DISTINCT FROM NEW.publication_origin_id THEN
            RAISE EXCEPTION 'TAX13_LEGAL_SCOPE_INVALID_SUPERSESSION';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tax13_legal_scope_provenance
BEFORE INSERT ON public.publication_legal_scope_attestations
FOR EACH ROW
EXECUTE FUNCTION public.tax13_legal_scope_validate_provenance();

ALTER TABLE public.publication_legal_scope_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_legal_scope_attestations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.publication_legal_scope_attestations
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

-- The worker may only READ evidence for a current in-scope publication;
-- no INSERT/UPDATE/DELETE privilege. Ordinary app and tenant roles see none.
GRANT SELECT ON public.publication_legal_scope_attestations TO radar_worker;

CREATE POLICY tax13_worker_select_current_legal_scope
ON public.publication_legal_scope_attestations
FOR SELECT TO radar_worker
USING (
    EXISTS (
        SELECT 1
        FROM public.publication_versions pv
        WHERE pv.id = publication_version_id
          AND pv.is_current
          AND public.publication_scope_is_in_scope(pv.publication_id)
    )
);

REVOKE ALL ON FUNCTION public.tax13_legal_scope_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tax13_legal_scope_validate_provenance() FROM PUBLIC;
