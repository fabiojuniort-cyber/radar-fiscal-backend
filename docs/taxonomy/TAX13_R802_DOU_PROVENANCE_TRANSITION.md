# Trifaros — TAX13-R8-02: provenance of contemporary DOU PDF documents

**Owner's latest binding decision (2026-10-10) overrides earlier certificate-based design in this PR.** Evidence source policy: **a PDF downloaded from a reliable official government DOU HTTPS source is sufficient as publication source**. Do not validate PDF digital-signing certificates, ICP-Brasil policy, OCSP, CRLs, timestamp authority, or separate reviewer signatures as prerequisites. Do not require ITI VALIDAR reports from the user.

**State:** R9/production BLOCK until the official-source transport, exact publication-to-act correspondence, and legal-effectivity cases are proved and independently reviewed. This is NOT a relaxation of existing migration 048 for synthetic assertions; change any SQL gate only via separate additive, versioned design and security regression.

## Source-of-publication requirements (not certificate requirements)

1. Fetch PDF bytes using a **controlled server-side HTTPS request** to the exact official Imprensa Nacional host and endpoint. Validate URL, redirects, status, media type, bounded response size; do not treat a mere copied URL or arbitrary user-uploaded bytes as evidence of an automated government HTTPS fetch. A manually uploaded official-looking PDF is a document candidate until source attribution is recorded. Never fabricate transport receipts.
2. Record source URL, fetch timestamp, PDF SHA-256 (for integrity/deduplication only), byte size, edition label, date, section and printed page; preserve the exact original bytes only if single-copy bounded retention is separately approved. Keep large PDFs, scans and JPG outside PostgreSQL; do not replicate by tenant.
3. Compare the PDF's printed edition/date/page/act identifiers and bounded text span to the captured DOU INLABS XML/ZIP, idMateria, dispatch parent and CONFAZ act. Exact identity matters; a regular edition, edition EXTRA 80-A and EXTRA 80-B are distinct publications.
4. Maintain the separate **legal effectivity** gate: national ratification, amendments, supersession, revocations, applicable legal period, text current by device. A law can be authentically published but no longer vigente. Taxonomy/NCM green CURRENT only after the legal gate is satisfied by real evidence.
5. Keep the existing migration 048 original-HTTP gate fail closed. Do NOT spoof official transport, create fake signed reviews, delete negative regression or automatically promote a PDF from a user upload. Design a **versioned, independently reviewed DOU/INLABS source pathway** if it is to support legal CURRENT in the SQL worker.
6. Run security cases PostgreSQL 16/18, CI and an adversarial independent R9 review before considering merges #186/#192/#193/#194 or Railway deployment.

## Implemented in PR #194 — lightweight, not yet admission to CURRENT

- `dou-source-custody-preflight.ts` validates INLABS XML/ZIP, page URL, edition, source matter and exact parent → embedded CONFAZ act boundaries. Output remains `DOU_XML_TRACE_ONLY`, not legal CURRENT.
- `dou-pdf-byte-preflight.ts` validates official-host page URL and date/journal/page match, basic PDF envelope, max 20 MiB and SHA-256. It does **not** inspect digital signatures or certificate fields. For page PDFs under a controlled source fetch, it produces bounded metadata without bytes/text in return.
- `dou-official-http-pdf-capture.ts` performs a bounded single-page request on the official Imprensa Nacional HTTPS host derived from the INLABS page trace, refuses redirects, oversized and non-PDF response, and returns source-capture metadata. It is read-only and does not mint legal proof.
- Deleted the unused optional Ed25519/PDF certificate-review module and its positive reviewer-signature tests in favor of the owner's simpler source policy. Earlier commits remain auditable but are superseded.
- The DOU provenance unit/negative suites distinguish source identity from effectivity and never create a synthetic CURRENT.

## Real contemporary sample — user-provided PDFs, verified identity

**DOU of 25 April 2024**, Seção 1:

| Edition | Upload | Pages | Byte SHA-256 | Printed content |
| --- | --- | ---: | --- | --- |
| Regular #80 | `2024_04_25_ASSINADO_do1.pdf` | 117 | `b51317aec8b211e044a473f6f959e5891159b9503d68ff543954c4728038a7cf` | Not Dispatch 16 |
| Extra #80-A | `2024_04_25_ASSINADO_do1_extra_A.pdf` | 6 | `1097fa01424658c6b6f06f8213ad887757be690ddec8cb37f092f4a658ca8743` | CONTRAN Resolução 1009/2024 |
| **Extra #80-B** | `2024_04_25_ASSINADO_do1_extra_B.pdf` | **1** | `e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201` | **CONFAZ Despacho 16/2024, Convênio ICMS 15/2024** |

Extra #80-B page 1 contains national authenticity-reference identifier `06012024042500001`, printed **DESPACHO Nº 16 DE 25/04/2024**, complete CONVÊNIO ICMS Nº 15/2024 original text (clauses 1–4), and a clause placing entry into force at publication of national ratification with effects retroactive to 01/04/2024. Official reference: https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?captchafield=firstAccess&data=25%2F04%2F2024&jornal=601&pagina=1 . These uploaded bytes are a correct **edition/document-identity sample**, but their independent direct fetch from the government server was not observed in this conversation.

CONFAZ official source: https://www.confaz.fazenda.gov.br/legislacao/convenios/2024/CV015_24 . The page confirms publication in 25/04/2024 extra via Despacho 16/24 and national ratification published 02/05/2024 via Ato Declaratório 10/24. Correlating original publication + ratification does not by itself establish that every effect remained CURRENT on 10/10/2026; later changes need checking.

**No original PDF is committed to GitHub**, no production data were changed, and the suspended 1991/1997 DOU archive work is NOT reactivated.

## Next steps

1. Test bounded direct official HTTPS capture and log official success/error separately; never equate tool/network failure with no publication.
2. Trace Extra #80-B as source sample and compare bounded 15/24 act clauses and publication/ratification references to INLABS, with missing official direct-fetch explicitly recorded if relevant.
3. Plan a versioned source-path SQL change only if required to support legal CURRENT, and submit to PG16/18 and independent R9 before deployment; preserve migration 048 protections in the meantime.
4. CI/R7/TAX11 synthetic positive failures cannot be resolved by weakening legal guards. Prepare legitimate test evidence and review amendments/effectivity first.

**Historical identifier compatibility:** Product is Trifaros; old repository names, immutable SQL function names and signed historical ledgers retain legacy identifiers until controlled migrations.
