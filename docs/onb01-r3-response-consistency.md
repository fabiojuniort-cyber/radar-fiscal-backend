# ONB-01 R3 — registration response consistency

Company and establishment registration (manual and CNPJ provider) now reads the response fields and CNAEs from PostgreSQL inside the same tenant transaction that creates or reactivates the record. The response describes persisted state, including preserved fields on explicit reactivation, manual Local Negócio/IE and canonical CNAE descriptions. Provider consultation metadata remains under `registry`; it does not claim that preserved cadastral fields were refreshed.

The identity, permission, RLS, reactivation and catalog validation rules are unchanged. Existing response fields remain; manual establishment responses additionally include address, IE status and persisted CNAEs, consistent with company establishment readback.

Regression coverage in `onboarding-integrity.integration.test.ts` compares registration responses against authenticated GET and SQL for new manual registration and explicit company/branch reactivation with conflicting submitted fields. `product-api.integration.test.ts` covers persisted automatic registration/reactivation and canonical CNAEs. Requires a disposable migrated PostgreSQL 18 database and non-superuser runtime role; never run these tests against production.
