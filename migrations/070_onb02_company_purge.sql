-- ONB-02-R3: physical deletion of a tenant company with all company-owned rows.
-- A SECURITY DEFINER entrypoint is used instead of granting DELETE on companies
-- to radar_app. The runtime privilege invariants and tenant RLS stay intact.
-- No existing data is changed by this migration; it is an opt-in endpoint action.
-- REVIEW GATE: confirm all company-specific FKs and audit/retention obligations
-- against the current PostgreSQL schema before merge/deploy.

CREATE OR REPLACE FUNCTION public.app_purge_company(
    p_company_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_tenant UUID := public.app_current_tenant_id();
    v_actor UUID := public.app_current_user_id();
    v_cnpj CHAR(14);
BEGIN
    IF v_tenant IS NULL OR v_actor IS NULL
       OR NOT public.app_user_is_tenant_admin(v_tenant) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    -- Only the company belonging to the authenticated tenant is eligible.
    -- Row lock serializes overlapping actions with this endpoint.
    SELECT c.head_office_cnpj INTO v_cnpj
    FROM public.companies c
    WHERE c.id = p_company_id AND c.tenant_id = v_tenant
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- publication_matches has a NO ACTION FK to monitoring_profiles, so
    -- delete those matches explicitly before cascading profiles. This does
    -- NOT remove the shared/global publication or its official history.
    DELETE FROM public.publication_matches pm
    WHERE pm.company_publication_id IN (
        SELECT cp.id FROM public.company_publications cp
        WHERE cp.company_id = p_company_id
    ) OR pm.monitoring_profile_id IN (
        SELECT mp.id FROM public.monitoring_profiles mp
        WHERE mp.company_id = p_company_id
    );

    -- 002/005/026/032 and related company-owned tables use ON DELETE CASCADE.
    -- Child deletion is atomic within withTenantContext's transaction.
    DELETE FROM public.companies c
    WHERE c.id = p_company_id AND c.tenant_id = v_tenant;

    -- Legacy signup may have stored the same CNPJ before ONB-01.
    -- Clear only that company's cadastral fields; retain user consent.
    UPDATE public.tenant_onboarding_profiles p
    SET cnpj = NULL, company_name = NULL
    WHERE p.tenant_id = v_tenant AND p.cnpj = v_cnpj;

    -- Audit the action without persisting the deleted CNPJ or company ID.
    INSERT INTO public.audit_log(
        tenant_id, actor_type, actor_id, action, entity_type,
        entity_id, after_data, correlation_id
    )
    VALUES (
        v_tenant, 'USER', v_actor::text, 'COMPANY_PURGED',
        'company', NULL, '{"purged": true}'::jsonb, gen_random_uuid()
    );

    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.app_purge_company(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_purge_company(UUID) FROM radar_worker;
GRANT EXECUTE ON FUNCTION public.app_purge_company(UUID) TO radar_app;
