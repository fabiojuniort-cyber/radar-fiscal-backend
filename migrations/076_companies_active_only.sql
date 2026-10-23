-- ONB-02 R8: a company is active until explicitly purged through the service.
-- No cleanup/automatic deletion: deployment must fail if legacy inactive rows remain.
-- Existing API fields are retained for backwards compatibility.
ALTER TABLE public.companies
  ADD CONSTRAINT companies_active_only CHECK (is_active IS TRUE);
