-- ONB-02-R3: physical deletion of a tenant company with all company-owned rows.
-- A SECURITY DEFINER entrypoint is used instead of granting DELETE on companies
-- to radar_app. The runtime privilege invariants and tenant RLS stay intact.
-- No existing data is changed by this migration; it is an opt-in endpoint action.
-- REVIEW GATE: confirm all company-specific FKs and audit/retention obligations
-- against the current PostgreSQL schema before merge/deploy.

-- ONB-02 R4: redact only strongly attributable historical audit values.
-- Literal matching avoids regex injection and preserves audit structure.
CREATE OR REPLACE FUNCTION public.onb02_redact_literal_ci(p_text TEXT,p_needle TEXT,p_mask TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $lit$
DECLARE v_rest TEXT:=p_text; v_out TEXT:=''; v_at INTEGER;
BEGIN
 IF p_text IS NULL OR p_needle IS NULL OR p_needle='' THEN RETURN p_text; END IF;
 LOOP
  v_at:=strpos(lower(v_rest),lower(p_needle));
  EXIT WHEN v_at=0;
  v_out:=v_out||substr(v_rest,1,v_at-1)||p_mask;
  v_rest:=substr(v_rest,v_at+char_length(p_needle));
 END LOOP;
 RETURN v_out||v_rest;
END;
$lit$;

-- R5: stable accent- and case-insensitive exact-name comparisons.
CREATE OR REPLACE FUNCTION public.onb02_normalize_company_name(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $norm$
  SELECT btrim(regexp_replace(
    translate(lower(coalesce(p_value,'')),
      'áàâãäåāéèêëēíìîïīóòôõöōúùûüūçñ',
      'aaaaaaaeeeeeiiiiioooooouuuuucn'),
    '[[:space:]]+',' ','g'))
$norm$;

CREATE INDEX IF NOT EXISTS ix_audit_r5_tenant_entity
ON public.audit_log (tenant_id, entity_id);

REVOKE ALL ON FUNCTION public.onb02_normalize_company_name(TEXT)
  FROM PUBLIC,radar_app,radar_worker;

CREATE OR REPLACE FUNCTION public.onb02_redact_audit_json(p_json JSONB,p_ids TEXT[],p_cnpjs TEXT[],p_names TEXT[])
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $mask$
DECLARE v_type TEXT; v_text TEXT; v_needle TEXT; v_fmt TEXT; v_key TEXT; v_child JSONB; v_result JSONB;
BEGIN
 IF p_json IS NULL THEN RETURN NULL; END IF;
 v_type:=jsonb_typeof(p_json);
 IF v_type='string' OR v_type='number' THEN
  v_text:=CASE WHEN v_type='string' THEN p_json #>> '{}' ELSE p_json::text END;
  FOREACH v_needle IN ARRAY coalesce(p_ids,ARRAY[]::text[]) LOOP
    v_text:=public.onb02_redact_literal_ci(v_text,v_needle,'[ID_MASCARADO]');
  END LOOP;
  FOREACH v_needle IN ARRAY coalesce(p_cnpjs,ARRAY[]::text[]) LOOP
    v_text:=public.onb02_redact_literal_ci(v_text,v_needle,'[CNPJ_MASCARADO]');
    IF char_length(v_needle)=14 THEN
      v_fmt:=substr(v_needle,1,2)||'.'||substr(v_needle,3,3)||'.'||substr(v_needle,6,3)||
             '/'||substr(v_needle,9,4)||'-'||substr(v_needle,13,2);
      v_text:=public.onb02_redact_literal_ci(v_text,v_fmt,'[CNPJ_MASCARADO]');
    END IF;
  END LOOP;
  FOREACH v_needle IN ARRAY coalesce(p_names,ARRAY[]::text[]) LOOP
    IF public.onb02_normalize_company_name(v_text) =
       public.onb02_normalize_company_name(v_needle) THEN
       v_text:='[NOME_EMPRESA_MASCARADO]';
       EXIT;
    END IF;
  END LOOP;
  IF v_type='number' AND v_text=p_json::text THEN RETURN p_json; END IF;
  RETURN to_jsonb(v_text);
 ELSIF v_type='object' THEN
  v_result:='{}'::jsonb;
  FOR v_key,v_child IN SELECT key,value FROM jsonb_each(p_json) LOOP
    v_result:=v_result||jsonb_build_object(v_key,
      public.onb02_redact_audit_json(v_child,p_ids,p_cnpjs,p_names));
  END LOOP;
  RETURN v_result;
 ELSIF v_type='array' THEN
  v_result:='[]'::jsonb;
  FOR v_child IN SELECT value FROM jsonb_array_elements(p_json) LOOP
    v_result:=v_result||jsonb_build_array(
      public.onb02_redact_audit_json(v_child,p_ids,p_cnpjs,p_names));
  END LOOP;
  RETURN v_result;
 END IF;
 RETURN p_json;
END;
$mask$;

REVOKE ALL ON FUNCTION public.onb02_redact_literal_ci(TEXT,TEXT,TEXT) FROM PUBLIC,radar_app,radar_worker;
REVOKE ALL ON FUNCTION public.onb02_redact_audit_json(JSONB,TEXT[],TEXT[],TEXT[]) FROM PUBLIC,radar_app,radar_worker;

CREATE OR REPLACE FUNCTION public.app_purge_company(
    p_company_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '30s'
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
    v_private_ids TEXT[];
    v_private_cnpjs TEXT[];
    v_private_names TEXT[];
    v_normalized_names TEXT[];
    v_ambiguous_names TEXT[];
    v_ambiguous_name_count INTEGER := 0;
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

    -- Gather private identifiers before cascading. Do not include tenant, user, or global acts.
    SELECT coalesce(array_agg(DISTINCT ref),ARRAY[]::text[]) INTO v_private_ids FROM (
      SELECT id::text AS ref FROM public.companies WHERE id=p_company_id
      UNION ALL SELECT id::text FROM public.establishments WHERE company_id=p_company_id
      UNION ALL SELECT id::text FROM public.company_tax_profiles WHERE company_id=p_company_id
      UNION ALL SELECT id::text FROM public.company_product_profiles WHERE company_id=p_company_id
      UNION ALL SELECT id::text FROM public.monitoring_profiles WHERE company_id=p_company_id
      UNION ALL SELECT id::text FROM public.company_publications WHERE company_id=p_company_id
      UNION ALL SELECT id::text FROM public.publication_matches
       WHERE monitoring_profile_id IN (SELECT id FROM public.monitoring_profiles WHERE company_id=p_company_id)
          OR company_publication_id IN (SELECT id FROM public.company_publications WHERE company_id=p_company_id)
    ) refs;
    SELECT coalesce(array_agg(DISTINCT ref),ARRAY[]::text[]) INTO v_private_cnpjs FROM (
      SELECT regexp_replace(head_office_cnpj::text,'[^0-9]','','g') AS ref
       FROM public.companies WHERE id=p_company_id
      UNION ALL SELECT regexp_replace(cnpj::text,'[^0-9]','','g')
       FROM public.establishments WHERE company_id=p_company_id
    ) refs;
    SELECT coalesce(array_agg(DISTINCT name),ARRAY[]::text[]) INTO v_private_names FROM (
      SELECT legal_name AS name FROM public.companies WHERE id=p_company_id
      UNION ALL SELECT trade_name FROM public.companies WHERE id=p_company_id
      UNION ALL SELECT name FROM public.establishments WHERE company_id=p_company_id
    ) names WHERE name IS NOT NULL AND btrim(name)<>'';

    -- R5: a homonymous company in THIS tenant makes that name ambiguous.
    -- Count DISTINCT other company IDs; never persist any competing name.
    SELECT COALESCE(array_agg(DISTINCT public.onb02_normalize_company_name(name)),ARRAY[]::text[])
      INTO v_normalized_names
      FROM unnest(v_private_names) AS names(name);

    SELECT count(DISTINCT company_id)::int,
           COALESCE(array_agg(DISTINCT normalized_name),ARRAY[]::text[])
      INTO v_ambiguous_name_count,v_ambiguous_names
    FROM (
      SELECT c.id AS company_id, public.onb02_normalize_company_name(n.name) AS normalized_name
        FROM public.companies c
        CROSS JOIN LATERAL unnest(ARRAY[c.legal_name,c.trade_name]) AS n(name)
        WHERE c.tenant_id=v_tenant AND c.id<>p_company_id AND n.name IS NOT NULL
      UNION ALL
      SELECT c.id,public.onb02_normalize_company_name(e.name)
        FROM public.companies c
        JOIN public.establishments e ON e.company_id=c.id
        WHERE c.tenant_id=v_tenant AND c.id<>p_company_id AND e.name IS NOT NULL
    ) others
    WHERE normalized_name=ANY(v_normalized_names)
      AND normalized_name<>'';

    SELECT COALESCE(array_agg(DISTINCT original_name),ARRAY[]::text[])
      INTO v_private_names
      FROM unnest(v_private_names) AS target_names(original_name)
    WHERE public.onb02_normalize_company_name(original_name)
          <> ALL(v_ambiguous_names);

    -- Never change an audit associated with a DIFFERENT entity, even when
    -- its JSON mentions the target company as a third-party reference.
    -- Name-only historical audit is eligible only on an unowned/empty entity_id.
    UPDATE public.audit_log a
       SET entity_id=CASE WHEN a.entity_id IS NULL THEN NULL
         ELSE public.onb02_redact_audit_json(
           to_jsonb(a.entity_id),v_private_ids,v_private_cnpjs,v_private_names) #>> '{}' END,
           before_data=public.onb02_redact_audit_json(a.before_data,v_private_ids,v_private_cnpjs,v_private_names),
           after_data=public.onb02_redact_audit_json(a.after_data,v_private_ids,v_private_cnpjs,v_private_names)
     WHERE a.tenant_id=v_tenant
       AND (
         NULLIF(a.entity_id,'') IS NULL
         OR EXISTS (SELECT 1 FROM unnest(v_private_ids) AS r(id)
           WHERE strpos(lower(a.entity_id),lower(r.id))>0)
         OR regexp_replace(coalesce(a.entity_id,''),'[^0-9]','','g')=ANY(v_private_cnpjs)
         OR public.onb02_normalize_company_name(a.entity_id)=ANY(
           SELECT public.onb02_normalize_company_name(n) FROM unnest(v_private_names) n)
       )
       AND (
         EXISTS (SELECT 1 FROM unnest(v_private_ids) AS r(id)
           WHERE strpos(lower(coalesce(a.entity_id,'')),lower(r.id))>0
             OR strpos(lower(coalesce(a.before_data::text,'')),lower(r.id))>0
             OR strpos(lower(coalesce(a.after_data::text,'')),lower(r.id))>0)
         OR EXISTS (SELECT 1 FROM unnest(v_private_cnpjs) AS r(cnpj)
           WHERE regexp_replace(coalesce(a.entity_id,''),'[^0-9]','','g')=r.cnpj
              OR strpos(coalesce(a.before_data::text,''),r.cnpj)>0
              OR strpos(coalesce(a.after_data::text,''),r.cnpj)>0
              OR (length(r.cnpj)=14 AND (
                 strpos(coalesce(a.before_data::text,''),
                   substr(r.cnpj,1,2)||'.'||substr(r.cnpj,3,3)||'.'||substr(r.cnpj,6,3)||
                   '/'||substr(r.cnpj,9,4)||'-'||substr(r.cnpj,13,2))>0
                 OR strpos(coalesce(a.after_data::text,''),
                   substr(r.cnpj,1,2)||'.'||substr(r.cnpj,3,3)||'.'||substr(r.cnpj,6,3)||
                   '/'||substr(r.cnpj,9,4)||'-'||substr(r.cnpj,13,2))>0)))
         OR (cardinality(v_private_names)>0 AND (
           public.onb02_redact_audit_json(
             a.before_data,ARRAY[]::text[],ARRAY[]::text[],v_private_names)
               IS DISTINCT FROM a.before_data
           OR public.onb02_redact_audit_json(
             a.after_data,ARRAY[]::text[],ARRAY[]::text[],v_private_names)
               IS DISTINCT FROM a.after_data
           OR public.onb02_normalize_company_name(a.entity_id)=ANY(
             SELECT public.onb02_normalize_company_name(n) FROM unnest(v_private_names) n)
         ))
       );

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
        'company', NULL, jsonb_build_object('purged',true,'ambiguous_name_count',v_ambiguous_name_count), gen_random_uuid()
    );

    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.app_purge_company(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_purge_company(UUID) FROM radar_worker;
GRANT EXECUTE ON FUNCTION public.app_purge_company(UUID) TO radar_app;
