> **POLÍTICA ATUAL (10/10/2026, Trifaros):** A análise de certificados/ICP/OCSP documentada abaixo é apenas registro técnico histórico, NÃO um requisito de publicação, admissibilidade ou próximos passos. O proprietário adotou PDF de fonte oficial confiável + URL/identidade/texto/hash. Ver `TAX13_R802_DOU_PROVENANCE_TRANSITION.md`. Não solicitar VALIDAR/ITI.

# Trifaros / TAX13-R8-02 — User-provided DOU PDFs, local forensic checkpoint

**Date:** 2026-10-09. **State:** external-origin and revocation BLOCKED. No changes to production, NCM seals, migrations, or legal CURRENT. This is an investigation record, NOT legal authenticity attestation.

## Uploaded editions (read locally; originals NOT committed)

| Field | Contemporary evidence candidate | Non-active comparison |
| --- | --- | --- |
| Uploaded filename | `2026_10_09_ASSINADO_do1.pdf` | `DO1_2015_10_09.pdf` |
| PDF publication date | 2026-10-09 | 2015-10-09 |
| Official issue printed | Section 1, nº 192 | Section 1, nº 194 |
| PDF pages | 198 | 260 |
| Original byte size | 37,902,651 | 4,073,774 |
| SHA-256 of exact uploaded PDF bytes | `7d104717d90adca7ede5f718a2b9ba61dac8299f30e1d8a182bbe3086958b645` | `2b656981f360e1bc4e80f580705b98c4c4b51244f49452fafd3475b59f9b7a17` |
| Signature | CMS PKCS#7 detached `adbe.pkcs7.detached`, SHA-256, all bytes covered | CMS PKCS#7 detached SHA-1, all bytes covered |
| `pdfsig` cryptographic verification | `Signature is Valid` | `Signature is Valid` |
| `pdfsig` PKI status | `Unknown issue with Certificate or corrupted data` — **not trusted/verified** | `Certificate has Expired` (historical point-in-time signature may still have been valid) |

### 2026 signer and structural chain

- Claimed signer: `CN=DIARIO OFICIAL DA UNIAO` (ICP-Brasil); signing time **2026-10-09 05:00:14** (as encoded in CMS).
- Signer certificate validity interval **2026-06-22 18:26:24Z through 2027-06-22 18:26:24Z**; SHA-256 fingerprint `e2277113627cd325199795d312c13742e93d6e364099fd031bc858a320ff223c`.
- CMS includes signer, `AC do SERPRO Final SSL`, `AC SERPRO v4`, and `AC Raiz Brasileira v5`. All four certificate-signature mathematical checks pass offline with the attached public keys. **Internal chain mathematical validity is not sufficient evidence of an independently trusted PKI anchor or of nonrevocation**.
- SHA-256 fingerprint for the included root v5: `caa53fc6091c6951887c976e378f6ef89aa6377c55d97b6475422b71ed7e9b17`. **Independent public reference match:** official ITI 2018 WebTrust for CA assertion, appendix A, root v5 SHA-256, at https://www.gov.br/iti/pt-br/assuntos/comite-gestor/ITI_2018__WebTrust_for_CA_ReportManagement_Assertion.pdf . The current ITI root repository also lists root v5 and October 2026 CRLs: https://www.gov.br/iti/pt-br/assuntos/repositorio/repositorio-ac-raiz . Fingerprint matching alone is not live CRL/OCSP proof.
- The signing certificate includes `digitalSignature` and `contentCommitment` key usages; EKU contains `clientAuth`. **Specific policy/usage suitability for DOU PAdES must be reviewed independently**, not inferred from certificate subject, OU, or a PDF viewer status.
- **Blocked:** revocation/OCSP status for the signer and all intermediates was not obtainable; independent government download and comparison of the original PDF's SHA-256 was not completed; the exact signed edition cannot be elevated to SOURCE_AUTHENTICATED or legal CURRENT.

### CONFAZ provenance candidate inside the contemporary edition

The **printed page 35** (Section 1, 2026-10-09) contains:
1. `ATO COTEPE/PMPF Nº 28, DE 8 DE OUTUBRO DE 2026`: PMPF combustíveis, with stated prices applicable **from 2026-10-16**; this is an indication within the document, not a full legal-effectivity assessment.
2. `ATO DECLARATÓRIO Nº 23, DE 8 DE OUTUBRO DE 2026`: **ratifies** `Convênio ICMS nº 109/26` and `Convênio ICMS nº 111/26` as previously published on 2026-09-22.

Important: a **ratification notice is NOT the complete original text** of Convênios 109/26 and 111/26. Do not stamp them as captured/authenticated original acts or as CURRENT using this notice. Page 35 is a printable physical page within the 198-page signed edition; its page-reference identity still requires a separately trusted official PDF/INLABS matter binding and per-act exact text review.

### Mismatch with existing proof preflight, intentional fail-closed

Existing `preflightContemporaryDouPdfBytes` accepts **at most 20 MiB** and compares an official **single-page** `INPDFViewer` URL with `DOU_XML_TRACE_ONLY` identity. A 37.9 MB **complete signed edition** must NOT be silently fed through it, the cap increased ad hoc, or a page extracted as a new independently signed PDF (the derivative is not signed with the original cryptographic signature). A separate explicitly versioned, bounded **full-edition** verifier/custody design is required, with page-to-edition correspondence, byte/hash identity, independent signed-origin fetch, ICP/ITI CRL trust, and zero automatic legal promotion. Preserve existing 20 MiB guard.

The 2015 PDF is used **only** to understand signature compatibility. The owner suspended historical DOU ingestion and original recovery. Do not import, index or reprocess 2015 under TAX13-R8-02.

## Exact next steps

1. Obtain an independently acquired identical signed 2026 edition from the official Imprensa Nacional channel, recording the original source URL, TLS/session provenance, final redirect target and SHA-256. A user upload is an evidence candidate, not a trusted source by itself.
2. Obtain an **independent** authority source for ICP-Brasil v5 anchor and validate actual CRLs or OCSP for signer/intermediate/root at the relevant signing and review times; log verifiable status, freshness, policy and audit references. ITI root fingerprint match already independently corroborated; revocation and signing-policy assessment NOT completed.
3. Version a bounded full-edition custody/review adapter, preserving strict single-page preflight limits and 048 fail-closed gates. Avoid bulk PDF/JPG storage in PostgreSQL and per-tenant duplication.
4. Reconcile a **specific** contemporary CONFAZ act against its exact original text and INLABS matter/ZIP, distinguishing ratification from complete act and correcting/revoking amendments. Independently assess legal effectivity by device.
5. Run PostgreSQL 16/18 adverse tests, R7 positives only on independently proven source cases, complete CI and independent R9. **No** merge of #186/#192/#193/#194, production deploy/migrations, global NCM reprocessing, or green legal status before all gates pass.
