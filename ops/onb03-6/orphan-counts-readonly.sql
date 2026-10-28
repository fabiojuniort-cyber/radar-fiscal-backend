-- ONB-03.6: aggregates only. Execute with a read-only transaction/session.
-- No names, CNPJs, company/tenant/unit identifiers or row-level payloads leave the DB.
SELECT 'establishments_without_company' AS check_name, count(*) AS affected_count
FROM public.establishments e LEFT JOIN public.companies c ON c.id=e.company_id
WHERE c.id IS NULL
UNION ALL
SELECT 'active_establishments_with_inactive_company',count(*)
FROM public.establishments e JOIN public.companies c ON c.id=e.company_id
WHERE e.is_active AND NOT c.is_active
UNION ALL
SELECT 'units_with_root_different_from_company',count(*)
FROM public.establishments e JOIN public.companies c ON c.id=e.company_id
WHERE left(e.cnpj,8)<>left(c.head_office_cnpj,8)
UNION ALL
SELECT 'company_roots_split_in_same_tenant',count(*)
FROM (SELECT tenant_id,left(head_office_cnpj,8) FROM public.companies
      GROUP BY tenant_id,left(head_office_cnpj,8) HAVING count(*)>1) roots
UNION ALL
SELECT 'non_0001_account_matrix_not_proof_of_orphan',count(*) FROM public.companies c
WHERE substring(c.head_office_cnpj,9,4)<>'0001'
-- A non-0001 first CNPJ is allowed as the account matrix by PROD-5.
-- This count alone does NOT prove an orphan or incorrect registration.
UNION ALL
SELECT 'non_0001_companies_in_split_roots',count(*) FROM public.companies c
WHERE substring(c.head_office_cnpj,9,4)<>'0001' AND EXISTS(
 SELECT 1 FROM public.companies sibling WHERE sibling.tenant_id=c.tenant_id
 AND sibling.id<>c.id AND left(sibling.head_office_cnpj,8)=left(c.head_office_cnpj,8))
UNION ALL
SELECT 'nonhead_units_without_active_head_in_company',count(*)
FROM public.establishments e WHERE e.is_active AND NOT e.is_head_office
AND NOT EXISTS(SELECT 1 FROM public.establishments h WHERE h.company_id=e.company_id AND h.is_active AND h.is_head_office);
