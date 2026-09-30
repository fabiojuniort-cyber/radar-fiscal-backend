-- Allow the authenticated application runtime to maintain the CNAE
-- reference catalog while registering companies/establishments from
-- authoritative CNPJ registry data.
--
-- Tenant-scoped links remain protected by the existing RLS policies on
-- company_cnaes and establishment_cnaes. The global cnaes table contains
-- only code/description reference data.

GRANT INSERT, UPDATE
ON cnaes
TO radar_app;
