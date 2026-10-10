> **POLÍTICA ATUAL (10/10/2026, Trifaros):** A análise de certificados/ICP/OCSP documentada abaixo é apenas registro técnico histórico, NÃO um requisito de publicação, admissibilidade ou próximos passos. O proprietário adotou PDF de fonte oficial confiável + URL/identidade/texto/hash. Ver `TAX13_R802_DOU_PROVENANCE_TRANSITION.md`. Não solicitar VALIDAR/ITI.

# Trifaros TAX13-R8-02 — DOU 25 April 2024: signed regular edition is NOT the certified extraordinary issue

**Checked:** 2026-10-09. **Security judgment: BLOCK legal CURRENT.** Technical verification only, no real-data import/merge/deploy and no historical 1991/1997 work.

## Primary user-provided PDF

- Upload `2024_04_25_ASSINADO_do1.pdf`, inspected read-only, never committed.
- **Regular DOU 25 April 2024, Seção 1, edition #80; 117 pages.** Source document's own first-page authenticity identifier: `05152024042500001`. **NOT edition EXTRA #80-B.**
- Actual byte size `7294935`. SHA-256 `b51317aec8b211e044a473f6f959e5891159b9503d68ff543954c4728038a7cf`.
- One CMS detached SHA-256 signature (`adbe.pkcs7.detached`). `pdfsig` reports `Signature is Valid` and `Total document signed`. Independently checked CMS `message_digest` SHA-256 equals the signed PDF byte ranges and both byte ranges cover the whole file.
- Signed time in CMS: **2024-04-25 05:01:33 UTC**. Subject: `CN=*.in.gov.br, O=IMPRENSA NACIONAL, serialNumber=04196645000100`; SHA-256 certificate fingerprint `f7e5f4388182fccf54ed6ba94e28579d4db43b421f2f04f7f064b3c74773ae8b`.
- The embedded signer certificate was nominally valid **2023-07-04 13:03:35Z through 2024-07-03 13:03:35Z**: expired NOW, but not expired at its claimed signing time. `pdfsig` currently reports `Certificate has Expired`; historical time validity and trustworthy timestamp need independent confirmation.
- **Important certificate policy concern:** embedded certificate has EKU `serverAuth` and `clientAuth`, KEY USAGE `digitalSignature=true`, `contentCommitment=false`. The certificate issuer claims `Autoridade Certificadora do SERPRO SSLv1` under `Autoridade Certificadora Raiz Brasileira v10`. Only the leaf certificate is embedded in PDF CMS. The acceptability of using an SSL server certificate for official PDF signing is **UNVERIFIED** and requires independent trust/policy review. No verified OCSP/CRL, timestamp authority, issuer chain to pinned trust root, or independent authenticated official download.
- The original PDF's printed page **53** has `ATO COTEPE/PMPF Nº 11, DE 24 DE ABRIL DE 2024`, an entirely different CONFAZ act about combustíveis / PMPF, with printed date-applicability from 1 May 2024. It is not Convênio 15/24 and cannot be silently substituted for it.
- Checks using PDF text extraction: `DESPACHO Nº 16` and `CONVÊNIO ICMS Nº 15` have **zero occurrences** in this regular signed PDF. No equivalence with the extra edition should be asserted.

## Independently identified correct official issue

- **DOU of 25 April 2024, edition EXTRA #80-B, Seção 1, exactly ONE page, journal ID 601**, NOT edition regular #80 / page 53.
- **Official Imprensa Nacional PDF viewer reference** (search-index text independently confirms issue #80-B, Despacho 16, Convênio ICMS 15, verification number `06012024042500001`): https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?captchafield=firstAccess&data=25%2F04%2F2024&jornal=601&pagina=1
- Important: official PDF viewer was indexed by search but direct original PDF-byte retrieval returned cache miss / download error in this execution. **No claimed SHA, PDF signature or authenticated custody for edition #80-B.**
- **Official CONFAZ page**: https://www.confaz.fazenda.gov.br/legislacao/convenios/2024/CV015_24 , states publication by **Despacho 16/24 in 25/04/24 Extra**, national ratification on **02/05/24 by Ato Declaratório 10/24**, and legal clause 4 stating in-force on the day of ratification publication, with effects stated to retroact to **01/04/24**. Treat as text/source metadata only; check subsequent amendments/revocations and legal criteria before any legal CURRENT determination.
- Distinct official printed authenticity codes:
  - Regular PDF #80 page 1: `05152024042500001`.
  - Extra PDF #80-B page 1: `06012024042500001`.
  These codes must not be interchanged, inferred from filenames or treated as standalone signed custody.

## Gate impact, no shortcut

The 117-page regular edition is a **real, cryptographically intact signed PDF** but **the wrong legal edition** for the case targeted by TAX13-R8-02. It CANNOT supply `certifiedPdfSha256` for the extra edition or be used for a positive test of Convênio ICMS 15/24. Existing preflight gates remain fail closed and unchanged. A successful SSL signer signature alone does NOT provide official legal proof under the current independent-root gate.

**Next operator action**: retrieve **original 1-page #80-B extra** through the official DOU viewer/link above and attach exact bytes without PDF printing/extraction/re-encoding. The first page MUST explicitly say `EDIÇÃO EXTRA` and `Ano CLXII Nº 80-B` and contain `DESPACHO Nº 16` + `CONVÊNIO ICMS Nº 15`. If direct official download remains broken, escalate access issue, never forge.

**After the right PDF:** verify hash, original PDF CMS signature, certificate trust chain, revocation at relevant times, official source identity and controlled acquisition, precise edition/page/act text binding, ratification evidence & per-segment legal effectivity, PG16/PG18 tests, independent R9. No production/merge until approved.
