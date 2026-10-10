# Trifaros TAX13-R8-02 — Railway one-time live capture evidence and cleanup

**Date/time UTC:** 2026-10-10 03:43:32–03:43:35. **Status:** OFFICIAL PDF HTTP GET SUCCEEDED; **byte identity with prior user-uploaded PDF not established**, no legal CURRENT claim. This is not a certificate, ICP, OCR or juridical review.

## Permission and isolation

The owner authorized creating a temporary Railway service **only for the capture** and expressly required deletion **as soon as the attempt finished**. No user confirmation for recurring executions, service retention, or production changes.

- Railway **existing disposable project**: `tax13-r802-temp-20261009` — project id `7b16c8a1-e81f-4685-8e30-d376ec4d6d0a`.
- Existing isolated environment: `r802-temporary` — id `7ebd0821-f873-4d08-aec3-f2b63721a216`.
- Preflight: **0 services**, **0 volumes**, **no staged changes**.
- One-shot Bun Function service: `trifaros-tax13-r802-once-delete`, id `e48f0871-d08f-43af-bbdf-21db0373b34e`. **Service intentionally permanently deleted as soon as result was read**. No domain, volume, database credentials, DB connection or scheduled job.
- Deployment id `482b8808-e0a5-4788-8c6e-d39fb30d7a9c` was SUCCESS before execution. One scripted GET and exit. The program neither writes fetched PDF bytes to disk nor retains a copy in storage.
- After result: `delete_service(projectId,serviceId,environmentId)` applied **LIVE**, `staged=null`, `detachedVolumes=[]`.
- Independent post-deletion inventory confirmed **0 services, 0 volumes, 0 staged changes** in `r802-temporary`. Production remained untouched.

## Captured official HTTP result

One direct request to:
`https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?captchafield=firstAccess&data=25%2F04%2F2024&jornal=601&pagina=1`

The single-purpose code constrained scheme, exact host/path, URL components, manual/no-follow redirects, 18s timeout, a 20 MiB in-memory cap, PDF MIME and `%PDF-`/`%%EOF` framing. It printed only bounded metadata. **It did not extract legal text, verify page content, correlate XML or issue proof.**

Captured exact structured observation, omitting fields repeated in the table:

| Field | Value |
| --- | --- |
| `id` | `TRIFAROS_R802_ONESHOT_20261010` |
| `startedAt` | `2026-10-10T03:43:32.390Z` |
| `completedAt` | `2026-10-10T03:43:34.944Z` |
| `status` | `CAPTURED_PDF_BYTES` |
| `httpStatus` | `200` |
| `contentType` | `application/pdf` |
| `redirectLocation` | `null` |
| `byteLength` | `865139` |
| `sha256` | `9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44` |
| `exactMatchToUploaded80B` | `false` |
| `declaredContentLength` | `null` |
| `legalCurrent` | `false` |

Railway DNS stream showed `pesquisa.in.gov.br` with `NOERROR`. The probe used standard HTTPS with no user-requested certificate examination; it did not validate PDF signatures, ICP-Brasil, OCSP or CRLs.

## Byte-level discrepancy and evidence limits

The prior **user-uploaded** one-page Extra #80-B sample had SHA-256 `e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201`. The captured 865,139-byte HTTP response has SHA-256 `9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44`: **not byte-identical**.

Possible reasons cannot be determined from this evidence alone. Do not claim that the PDFs carry the same publication text or that the mismatch invalidates either source. **The Railway probe did not preserve actual bytes, parse text, verify edition markers or correlate the original INLABS archive with the Convênio.** User-provided original text remains an independent DOCUMENT CANDIDATE; Railway shows that a government HTTPS endpoint returned a framed PDF for the intended page. This is NOT an authenticated legal vigency assertion or a SQL-migration-048 original-proof receipt.

## Strict next steps

1. **No more service now**: deletion is verified. Do not recreate without specific new authorization/cost acknowledgment.
2. Offline investigation: compare PDF content from a **future explicitly authorized same-buffer** source capture or an already available official original and the one-page uploaded Extra #80-B PDF, distinguishing content from PDF binary metadata. Do not infer equality from date/page URLs alone.
3. Correlate entire legal text to official INLABS XML/ZIP (when actually acquired) plus parent `DESPACHO 16/24`, `CONVÊNIO 15/24`, ratification `ATO DECLARATÓRIO 10/24` and subsequent amendments. Keep page vs edition distinct.
4. Only after verified source/act evidence propose an additive, independently reviewed SQL source pathway; never forge receipt, relax 048, or assert CURRENT automatically. Run PG16/18, R7 and independent R9 before any merge/deploy.

**Policy:** original PDF from trustworthy official source suffices for source publication identity without a PDF digital-certificate validation requirement. Legal effectiveness and currentness are separate.
