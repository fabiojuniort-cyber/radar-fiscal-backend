-- DOU-CLEAN-02 / tribusca-control#84
--
-- Reversible publication scope suppression. OUT_OF_SCOPE removes an act from
-- normal product reads while preserving the canonical publication, versions,
-- origins, files, taxonomy/NCM evidence, tenant history and collection audit.
-- Missing state means IN_SCOPE.
--
-- This migration intentionally does NOT implement a historical batch cleanup.
-- Scope transitions are owner/admin-only through the reviewed function below.

CREATE TABLE public.publication_scope_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publication_id UUID NOT NULL
        REFERENCES public.publications(id)
        ON DELETE RESTRICT,
    operation_id UUID NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('SUPPRESS', 'RESTORE')),
    previous_scope TEXT NOT NULL
        CHECK (previous_scope IN ('IN_SCOPE', 'OUT_OF_SCOPE')),
    new_scope TEXT NOT NULL
        CHECK (new_scope IN ('IN_SCOPE', 'OUT_OF_SCOPE')),
    policy_key TEXT NOT NULL
        CHECK (btrim(policy_key) <> ''),
    reason_code TEXT NOT NULL
        CHECK (btrim(reason_code) <> ''),
    rule_version TEXT NOT NULL
        CHECK (btrim(rule_version) <> ''),
    evidence_sha256 CHAR(64) NOT NULL
        CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
    manifest_sha256 CHAR(64)
        CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$'),
    actor_ref TEXT NOT NULL
        CHECK (btrim(actor_ref) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_publication_scope_operation
        UNIQUE (operation_id, publication_id),
    CONSTRAINT uq_publication_scope_event_publication
        UNIQUE (id, publication_id),
    CONSTRAINT chk_publication_scope_event_transition
        CHECK (
            (action = 'SUPPRESS'
             AND previous_scope = 'IN_SCOPE'
             AND new_scope = 'OUT_OF_SCOPE')
            OR
            (action = 'RESTORE'
             AND previous_scope = 'OUT_OF_SCOPE'
             AND new_scope = 'IN_SCOPE')
        )
);

CREATE INDEX ix_publication_scope_events_publication
ON public.publication_scope_events(publication_id, created_at DESC, id DESC);

CREATE TABLE public.publication_scope_state (
    publication_id UUID PRIMARY KEY
        REFERENCES public.publications(id)
        ON DELETE RESTRICT,
    scope TEXT NOT NULL
        CHECK (scope IN ('IN_SCOPE', 'OUT_OF_SCOPE')),
    current_event_id UUID NOT NULL,
    policy_key TEXT NOT NULL
        CHECK (btrim(policy_key) <> ''),
    evidence_sha256 CHAR(64) NOT NULL
        CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_publication_scope_state_current_event
        FOREIGN KEY (current_event_id, publication_id)
        REFERENCES public.publication_scope_events(id, publication_id)
        ON DELETE RESTRICT
);

CREATE INDEX ix_publication_scope_state_out
ON public.publication_scope_state(publication_id)
WHERE scope = 'OUT_OF_SCOPE';

-- Immutable decision history: restore is a compensating event, never deletion.
CREATE FUNCTION public.publication_scope_event_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'PUBLICATION_SCOPE_EVENT_APPEND_ONLY';
END;
$$;

CREATE TRIGGER publication_scope_events_append_only
BEFORE UPDATE OR DELETE ON public.publication_scope_events
FOR EACH ROW
EXECUTE FUNCTION public.publication_scope_event_append_only();

-- Central predicate. SECURITY DEFINER is deliberate: ordinary runtime roles do
-- not receive direct SELECT on the scope ledger, only the boolean decision.
CREATE FUNCTION public.publication_scope_is_in_scope(p_publication_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT NOT EXISTS (
        SELECT 1
        FROM public.publication_scope_state s
        WHERE s.publication_id = p_publication_id
          AND s.scope = 'OUT_OF_SCOPE'
    );
$$;

-- Tenant match visibility needs a scope check from company_publication_id
-- without granting ordinary runtime direct access to the scope ledger.
CREATE FUNCTION public.publication_scope_company_publication_is_in_scope(
    p_company_publication_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT COALESCE(
        (
            SELECT public.publication_scope_is_in_scope(cp.publication_id)
            FROM public.company_publications cp
            WHERE cp.id = p_company_publication_id
        ),
        false
    );
$$;

-- One audited transition. p_expected_current_event_id is an optimistic lock:
-- NULL means the caller positively expects no previous scope event.
CREATE FUNCTION public.apply_publication_scope_transition(
    p_publication_id UUID,
    p_action TEXT,
    p_operation_id UUID,
    p_expected_current_event_id UUID,
    p_policy_key TEXT,
    p_reason_code TEXT,
    p_rule_version TEXT,
    p_evidence_sha256 TEXT,
    p_manifest_sha256 TEXT,
    p_actor_ref TEXT
)
RETURNS TABLE (
    event_id UUID,
    resulting_scope TEXT,
    applied BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    current_scope TEXT := 'IN_SCOPE';
    current_event UUID;
    existing public.publication_scope_events%ROWTYPE;
    next_scope TEXT;
    created_event UUID;
BEGIN
    IF p_action NOT IN ('SUPPRESS', 'RESTORE') THEN
        RAISE EXCEPTION 'PUBLICATION_SCOPE_INVALID_ACTION';
    END IF;
    IF p_policy_key IS NULL OR btrim(p_policy_key) = ''
       OR p_reason_code IS NULL OR btrim(p_reason_code) = ''
       OR p_rule_version IS NULL OR btrim(p_rule_version) = ''
       OR p_actor_ref IS NULL OR btrim(p_actor_ref) = '' THEN
        RAISE EXCEPTION 'PUBLICATION_SCOPE_REQUIRED_METADATA';
    END IF;
    IF p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$'
       OR (p_manifest_sha256 IS NOT NULL AND p_manifest_sha256 !~ '^[a-f0-9]{64}$') THEN
        RAISE EXCEPTION 'PUBLICATION_SCOPE_INVALID_HASH';
    END IF;

    -- Serializes scope transitions with enrichment commit guards and with
    -- canonical material changes for this publication.
    PERFORM 1
    FROM public.publications p
    WHERE p.id = p_publication_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUBLICATION_SCOPE_PUBLICATION_NOT_FOUND';
    END IF;

    SELECT s.scope, s.current_event_id
    INTO current_scope, current_event
    FROM public.publication_scope_state s
    WHERE s.publication_id = p_publication_id
    FOR UPDATE;

    IF NOT FOUND THEN
        current_scope := 'IN_SCOPE';
        current_event := NULL;
    END IF;

    SELECT e.*
    INTO existing
    FROM public.publication_scope_events e
    WHERE e.operation_id = p_operation_id
      AND e.publication_id = p_publication_id;

    IF FOUND THEN
        IF existing.action IS DISTINCT FROM p_action
           OR existing.policy_key IS DISTINCT FROM p_policy_key
           OR existing.reason_code IS DISTINCT FROM p_reason_code
           OR existing.rule_version IS DISTINCT FROM p_rule_version
           OR existing.evidence_sha256::text IS DISTINCT FROM p_evidence_sha256
           OR existing.manifest_sha256::text IS DISTINCT FROM p_manifest_sha256
           OR existing.actor_ref IS DISTINCT FROM p_actor_ref THEN
            RAISE EXCEPTION 'PUBLICATION_SCOPE_OPERATION_CONFLICT';
        END IF;
        IF current_event IS DISTINCT FROM existing.id THEN
            RAISE EXCEPTION 'PUBLICATION_SCOPE_OPERATION_SUPERSEDED';
        END IF;
        RETURN QUERY SELECT existing.id, current_scope, false;
        RETURN;
    END IF;

    IF current_event IS DISTINCT FROM p_expected_current_event_id THEN
        RAISE EXCEPTION 'PUBLICATION_SCOPE_STALE_EXPECTATION';
    END IF;

    IF p_action = 'SUPPRESS' THEN
        IF current_scope <> 'IN_SCOPE' THEN
            RAISE EXCEPTION 'PUBLICATION_SCOPE_INVALID_TRANSITION';
        END IF;
        next_scope := 'OUT_OF_SCOPE';
    ELSE
        IF current_scope <> 'OUT_OF_SCOPE' THEN
            RAISE EXCEPTION 'PUBLICATION_SCOPE_INVALID_TRANSITION';
        END IF;
        next_scope := 'IN_SCOPE';
    END IF;

    INSERT INTO public.publication_scope_events (
        publication_id,
        operation_id,
        action,
        previous_scope,
        new_scope,
        policy_key,
        reason_code,
        rule_version,
        evidence_sha256,
        manifest_sha256,
        actor_ref
    ) VALUES (
        p_publication_id,
        p_operation_id,
        p_action,
        current_scope,
        next_scope,
        p_policy_key,
        p_reason_code,
        p_rule_version,
        p_evidence_sha256,
        p_manifest_sha256,
        p_actor_ref
    )
    RETURNING id INTO created_event;

    INSERT INTO public.publication_scope_state (
        publication_id,
        scope,
        current_event_id,
        policy_key,
        evidence_sha256,
        updated_at
    ) VALUES (
        p_publication_id,
        next_scope,
        created_event,
        p_policy_key,
        p_evidence_sha256,
        now()
    )
    ON CONFLICT (publication_id) DO UPDATE SET
        scope = EXCLUDED.scope,
        current_event_id = EXCLUDED.current_event_id,
        policy_key = EXCLUDED.policy_key,
        evidence_sha256 = EXCLUDED.evidence_sha256,
        updated_at = now();

    RETURN QUERY SELECT created_event, next_scope, true;
END;
$$;

-- Material mutations must never remain silently hidden under stale evidence.
-- A new/changed canonical body, origin envelope, or canonical publication
-- descriptor appends an automatic RESTORE event before normal processing ends.
CREATE FUNCTION public.restore_publication_scope_on_material_change(
    p_publication_id UUID,
    p_reason_code TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    state_row public.publication_scope_state%ROWTYPE;
    restore_event UUID;
BEGIN
    -- Same lock order as apply_publication_scope_transition: publication first.
    PERFORM 1
    FROM public.publications p
    WHERE p.id = p_publication_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT s.*
    INTO state_row
    FROM public.publication_scope_state s
    WHERE s.publication_id = p_publication_id
    FOR UPDATE;

    IF NOT FOUND OR state_row.scope <> 'OUT_OF_SCOPE' THEN
        RETURN;
    END IF;

    INSERT INTO public.publication_scope_events (
        publication_id,
        operation_id,
        action,
        previous_scope,
        new_scope,
        policy_key,
        reason_code,
        rule_version,
        evidence_sha256,
        manifest_sha256,
        actor_ref
    ) VALUES (
        p_publication_id,
        gen_random_uuid(),
        'RESTORE',
        'OUT_OF_SCOPE',
        'IN_SCOPE',
        state_row.policy_key,
        p_reason_code,
        'scope-material-change-v1',
        state_row.evidence_sha256,
        NULL,
        'SYSTEM_MATERIAL_CHANGE'
    )
    RETURNING id INTO restore_event;

    UPDATE public.publication_scope_state
    SET scope = 'IN_SCOPE',
        current_event_id = restore_event,
        updated_at = now()
    WHERE publication_id = p_publication_id;
END;
$$;

CREATE FUNCTION public.trg_publication_scope_publication_material()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF OLD.identity_hash IS DISTINCT FROM NEW.identity_hash
       OR OLD.identity_version IS DISTINCT FROM NEW.identity_version
       OR OLD.identity_strength IS DISTINCT FROM NEW.identity_strength
       OR OLD.identity_basis IS DISTINCT FROM NEW.identity_basis
       OR OLD.jurisdiction_level IS DISTINCT FROM NEW.jurisdiction_level
       OR OLD.uf IS DISTINCT FROM NEW.uf
       OR OLD.agency IS DISTINCT FROM NEW.agency
       OR OLD.act_type IS DISTINCT FROM NEW.act_type
       OR OLD.act_number IS DISTINCT FROM NEW.act_number
       OR OLD.title IS DISTINCT FROM NEW.title
       OR OLD.published_on IS DISTINCT FROM NEW.published_on
       OR OLD.effective_on IS DISTINCT FROM NEW.effective_on
       OR OLD.primary_official_url IS DISTINCT FROM NEW.primary_official_url THEN
        PERFORM public.restore_publication_scope_on_material_change(
            NEW.id,
            'PUBLICATION_MATERIAL_CHANGED'
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER publication_scope_publication_material
AFTER UPDATE ON public.publications
FOR EACH ROW
EXECUTE FUNCTION public.trg_publication_scope_publication_material();

CREATE FUNCTION public.trg_publication_scope_origin_material()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.restore_publication_scope_on_material_change(
            NEW.publication_id,
            'PUBLICATION_ORIGIN_ADDED'
        );
    ELSIF OLD.publication_id IS DISTINCT FROM NEW.publication_id
       OR OLD.source_id IS DISTINCT FROM NEW.source_id
       OR OLD.external_id IS DISTINCT FROM NEW.external_id
       OR OLD.official_url IS DISTINCT FROM NEW.official_url
       OR OLD.metadata IS DISTINCT FROM NEW.metadata THEN
        PERFORM public.restore_publication_scope_on_material_change(
            NEW.publication_id,
            'PUBLICATION_ORIGIN_CHANGED'
        );
        IF OLD.publication_id IS DISTINCT FROM NEW.publication_id THEN
            PERFORM public.restore_publication_scope_on_material_change(
                OLD.publication_id,
                'PUBLICATION_ORIGIN_MOVED'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER publication_scope_origin_material
AFTER INSERT OR UPDATE ON public.publication_origins
FOR EACH ROW
EXECUTE FUNCTION public.trg_publication_scope_origin_material();

CREATE FUNCTION public.trg_publication_scope_version_material()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.restore_publication_scope_on_material_change(
            NEW.publication_id,
            'PUBLICATION_VERSION_ADDED'
        );
    ELSIF OLD.publication_id IS DISTINCT FROM NEW.publication_id
       OR OLD.content_hash IS DISTINCT FROM NEW.content_hash
       OR OLD.content_text IS DISTINCT FROM NEW.content_text
       OR OLD.relevant_excerpt IS DISTINCT FROM NEW.relevant_excerpt
       OR OLD.source_metadata IS DISTINCT FROM NEW.source_metadata
       OR OLD.is_current IS DISTINCT FROM NEW.is_current THEN
        PERFORM public.restore_publication_scope_on_material_change(
            NEW.publication_id,
            'PUBLICATION_VERSION_CHANGED'
        );
        IF OLD.publication_id IS DISTINCT FROM NEW.publication_id THEN
            PERFORM public.restore_publication_scope_on_material_change(
                OLD.publication_id,
                'PUBLICATION_VERSION_MOVED'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER publication_scope_version_material
AFTER INSERT OR UPDATE ON public.publication_versions
FOR EACH ROW
EXECUTE FUNCTION public.trg_publication_scope_version_material();

-- Keep the scale feed authoritative: OUT_OF_SCOPE publications have no feed
-- row. Restore reconstructs it from preserved publications/origins.
CREATE OR REPLACE FUNCTION public.publication_source_feed_expected(p_publication_ids UUID[])
RETURNS TABLE (
    source_code TEXT,
    publication_id UUID,
    published_on DATE,
    first_collected_at TIMESTAMPTZ,
    is_hidden BOOLEAN
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT lower(s.code), p.id, p.published_on, p.first_collected_at, p.is_hidden
    FROM public.publications p
    JOIN public.publication_origins po
      ON po.publication_id = p.id
    JOIN public.sources s
      ON s.id = po.source_id
    WHERE p.id = ANY(p_publication_ids)
      AND public.publication_scope_is_in_scope(p.id)
      AND NOT (lower(s.code) = 'dou' AND p.is_confaz)
    UNION
    SELECT 'confaz', p.id, p.published_on, p.first_collected_at, p.is_hidden
    FROM public.publications p
    WHERE p.id = ANY(p_publication_ids)
      AND public.publication_scope_is_in_scope(p.id)
      AND p.is_confaz;
$$;

CREATE FUNCTION public.trg_publication_scope_refresh_feed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    PERFORM public.refresh_publication_source_feed(
        ARRAY[NEW.publication_id]
    );
    RETURN NULL;
END;
$$;

CREATE TRIGGER publication_scope_state_refresh_feed_insert
AFTER INSERT ON public.publication_scope_state
FOR EACH ROW
EXECUTE FUNCTION public.trg_publication_scope_refresh_feed();

CREATE TRIGGER publication_scope_state_refresh_feed_update
AFTER UPDATE OF scope ON public.publication_scope_state
FOR EACH ROW
WHEN (OLD.scope IS DISTINCT FROM NEW.scope)
EXECUTE FUNCTION public.trg_publication_scope_refresh_feed();

-- Product/API visibility: owner/admin bypasses these non-FORCE policies;
-- radar_worker keeps full canonical visibility for collection/replay. radar_app
-- sees only in-scope canonical rows, including direct-ID reads.
ALTER TABLE public.publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_run_publications ENABLE ROW LEVEL SECURITY;

CREATE POLICY publications_app_scope
ON public.publications
FOR SELECT TO radar_app
USING (public.publication_scope_is_in_scope(id));

CREATE POLICY publications_worker_all
ON public.publications
FOR ALL TO radar_worker
USING (true)
WITH CHECK (true);

CREATE POLICY publication_origins_app_scope
ON public.publication_origins
FOR SELECT TO radar_app
USING (public.publication_scope_is_in_scope(publication_id));

CREATE POLICY publication_origins_worker_all
ON public.publication_origins
FOR ALL TO radar_worker
USING (true)
WITH CHECK (true);

CREATE POLICY publication_versions_app_scope
ON public.publication_versions
FOR SELECT TO radar_app
USING (public.publication_scope_is_in_scope(publication_id));

CREATE POLICY publication_versions_worker_all
ON public.publication_versions
FOR ALL TO radar_worker
USING (true)
WITH CHECK (true);

CREATE POLICY publication_files_app_scope
ON public.publication_files
FOR SELECT TO radar_app
USING (
    EXISTS (
        SELECT 1
        FROM public.publication_versions pv
        WHERE pv.id = publication_version_id
          AND public.publication_scope_is_in_scope(pv.publication_id)
    )
);

CREATE POLICY publication_files_worker_all
ON public.publication_files
FOR ALL TO radar_worker
USING (true)
WITH CHECK (true);

CREATE POLICY collection_run_publications_app_scope
ON public.collection_run_publications
FOR SELECT TO radar_app
USING (public.publication_scope_is_in_scope(publication_id));

CREATE POLICY collection_run_publications_worker_all
ON public.collection_run_publications
FOR ALL TO radar_worker
USING (true)
WITH CHECK (true);

-- Tenant links remain stored, but normal tenant reads/inserts are additionally
-- constrained by publication scope. RESTRICTIVE composes with existing tenant
-- policies instead of widening them.
CREATE POLICY company_publications_app_scope
ON public.company_publications
AS RESTRICTIVE
FOR ALL TO radar_app
USING (public.publication_scope_is_in_scope(publication_id))
WITH CHECK (public.publication_scope_is_in_scope(publication_id));

CREATE POLICY company_publications_worker_scope
ON public.company_publications
AS RESTRICTIVE
FOR ALL TO radar_worker
USING (public.publication_scope_is_in_scope(publication_id))
WITH CHECK (public.publication_scope_is_in_scope(publication_id));

CREATE POLICY publication_matches_app_scope
ON public.publication_matches
AS RESTRICTIVE
FOR ALL TO radar_app
USING (
    public.publication_scope_company_publication_is_in_scope(
        company_publication_id
    )
)
WITH CHECK (
    public.publication_scope_company_publication_is_in_scope(
        company_publication_id
    )
);

CREATE POLICY publication_matches_worker_scope
ON public.publication_matches
AS RESTRICTIVE
FOR ALL TO radar_worker
USING (
    public.publication_scope_company_publication_is_in_scope(
        company_publication_id
    )
)
WITH CHECK (
    public.publication_scope_company_publication_is_in_scope(
        company_publication_id
    )
);

-- Ordinary runtime receives no raw ledger access and no transition privilege.
REVOKE ALL ON public.publication_scope_events,
              public.publication_scope_state
FROM PUBLIC, radar_app, radar_worker;

REVOKE ALL ON FUNCTION public.publication_scope_event_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publication_scope_is_in_scope(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publication_scope_company_publication_is_in_scope(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_publication_scope_transition(
    UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, radar_app, radar_worker;
REVOKE ALL ON FUNCTION public.restore_publication_scope_on_material_change(UUID, TEXT) FROM PUBLIC, radar_app, radar_worker;
REVOKE ALL ON FUNCTION public.trg_publication_scope_publication_material() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_publication_scope_origin_material() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_publication_scope_version_material() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_publication_scope_refresh_feed() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.publication_scope_is_in_scope(UUID)
TO radar_app, radar_worker;

GRANT EXECUTE ON FUNCTION public.publication_scope_company_publication_is_in_scope(UUID)
TO radar_app, radar_worker;

-- The curator has no raw canonical privileges. This narrow boundary locks
-- the publication before a manual derived write and rechecks scope using a
-- fresh READ COMMITTED statement snapshot after any conflicting transition.
CREATE FUNCTION public.publication_scope_lock_curator_version(p_version_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    publication_id UUID;
BEGIN
    SELECT p.id INTO publication_id
    FROM public.publication_versions pv
    JOIN public.publications p ON p.id = pv.publication_id
    WHERE pv.id = p_version_id AND pv.is_current
    FOR SHARE OF p;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUBLICATION_VERSION_NOT_FOUND';
    END IF;
    IF NOT public.publication_scope_is_in_scope(publication_id) THEN
        RAISE EXCEPTION 'PUBLICATION_OUT_OF_SCOPE';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.publication_scope_lock_curator_version(UUID)
FROM PUBLIC, radar_app, radar_worker;
GRANT EXECUTE ON FUNCTION public.publication_scope_lock_curator_version(UUID)
TO radar_taxonomy_curator;
