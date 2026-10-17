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
    v_legal_name TEXT;
    v_trade_name TEXT;
    v_onboarding_cnpj CHAR(14);
    v_onboarding_name TEXT;
    v_account_name TEXT;
BEGIN
    IF v_tenant IS NULL OR v_actor IS NULL
       OR NOT public.app_user_is_tenant_admin(v_tenant) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    -- Only the company belonging to the authenticated tenant is eligible.
    -- Row lock serializes overlapping actions with this endpoint.
    SELECT c.head_office_cnpj, c.legal_name, c.trade_name
      INTO v_cnpj, v_legal_name, v_trade_name
    FROM public.companies c
    WHERE c.id = p_company_id AND c.tenant_id = v_tenant
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Inserts/updates of matching rows take FK KEY SHARE locks on these
    -- parents; FOR UPDATE conflicts with them. Combined with the companies
    -- parent lock above, these locks close the check-vs-delete race at the
    -- default READ COMMITTED transaction isolation level.
    PERFORM mp.id FROM public.monitoring_profiles mp
    WHERE mp.company_id = p_company_id
    ORDER BY mp.id FOR UPDATE;
    PERFORM cp.id FROM public.company_publications cp
    WHERE cp.company_id = p_company_id
    ORDER BY cp.id FOR UPDATE;

    -- Reject BOTH inconsistent directions, including another company in the
    -- same tenant and a company belonging to a different tenant.
    IF EXISTS (
        SELECT 1
        FROM public.publication_matches pm
        JOIN public.monitoring_profiles mp ON mp.id = pm.monitoring_profile_id
        JOIN public.company_publications cp ON cp.id = pm.company_publication_id
        WHERE (mp.company_id = p_company_id OR cp.company_id = p_company_id)
          AND mp.company_id <> cp.company_id
    ) THEN
        RAISE EXCEPTION 'company_purge_cross_company_link'
            USING ERRCODE = '23514';
    END IF;

    -- Legacy identity is not necessarily the company: accounts can be
    -- renamed and can contain multiple businesses. Never silently erase an
    -- account label without verifiable linkage to the CNPJ being deleted.
    SELECT p.cnpj, p.company_name, t.name
      INTO v_onboarding_cnpj, v_onboarding_name, v_account_name
    FROM public.tenants t
    LEFT JOIN public.tenant_onboarding_profiles p ON p.tenant_id = t.id
    WHERE t.id = v_tenant
    FOR UPDATE OF t;

    IF v_onboarding_cnpj = v_cnpj THEN
        -- A legacy signup CNPJ is an explicit association, unlike a
        -- potentially customized tenant/account display name.
        UPDATE public.tenant_onboarding_profiles p
        SET cnpj = NULL, company_name = NULL
        WHERE p.tenant_id = v_tenant AND p.cnpj = v_cnpj;

        IF v_account_name = v_onboarding_name AND v_onboarding_name IS NOT NULL THEN
            -- Another company with the same name makes attribution ambiguous.
            IF EXISTS (
                SELECT 1 FROM public.companies c
                WHERE c.tenant_id = v_tenant
                  AND c.id <> p_company_id
                  AND (c.legal_name = v_account_name OR c.trade_name = v_account_name)
            ) THEN
                RAISE EXCEPTION 'company_purge_legacy_identity_ambiguous'
                    USING ERRCODE = '23514';
            END IF;
            UPDATE public.tenants SET name = 'Conta TriFaros'
            WHERE id = v_tenant AND name = v_account_name;
        ELSIF v_account_name IN (v_legal_name, v_trade_name)
              AND v_account_name IS NOT NULL THEN
            RAISE EXCEPTION 'company_purge_legacy_identity_ambiguous'
                USING ERRCODE = '23514';
        END IF;
    ELSIF (v_onboarding_name IS NOT NULL
           AND (v_onboarding_name = v_legal_name
                OR v_onboarding_name = v_trade_name))
           OR (v_account_name IS NOT NULL
               AND (v_account_name = v_legal_name
                    OR v_account_name = v_trade_name)) THEN
        -- A matching name without CNPJ evidence may be custom account data;
        -- refuse the deletion until a human resolves the ambiguity.
        RAISE EXCEPTION 'company_purge_legacy_identity_ambiguous'
            USING ERRCODE = '23514';
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
