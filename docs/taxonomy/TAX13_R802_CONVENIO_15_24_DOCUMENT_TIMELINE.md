# Trifaros — TAX13-R8-02: Convênio ICMS 15/24 | document comparison and legal chronology

**Date:** 2026-10-10. **Review verdict:** official source identity / legal timeline **CANDIDATE ONLY**; publication content verified manually at a documentary level, not cryptographically or by a real original-XML/PDF joined collector. No automatic CURRENT status. No PDF certificates, ICP, OCSP or CRL required.

## Compared materials and what they establish

**User-provided original PDF sample:** `2024_04_25_ASSINADO_do1_extra_B.pdf`, one page, DOU Section 1, Extra issue 80-B of 25 April 2024, SHA-256 `e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201`. The on-page authenticity reference is `06012024042500001`. Extracted text includes `DESPACHO Nº 16` and `CONVÊNIO ICMS Nº 15`, four clauses and the full list of signatories. The sample was read only, and the PDF itself was **not committed** to GitHub.

**Official CONFAZ public original act URL:**
https://www.confaz.fazenda.gov.br/legislacao/convenios/2024/CV015_24

**Official CONFAZ ratification URL:**
https://www.confaz.fazenda.gov.br/legislacao/atos-declaratorios/2024/ad010_24

**Live PDF receipt from one-shot Railway probe:** a direct GET to
`https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?captchafield=firstAccess&data=25%2F04%2F2024&jornal=601&pagina=1`
returned HTTP 200/PDF, 865139 bytes and hash `9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44`; the service was deleted immediately with no persisted downloaded PDF. The two PDF SHA values **differ**. Their actual contents CANNOT be compared after the fact because the Railway response bytes were not retained or text-extracted. **This is an open evidence gap**, not a finding of tampering or invalidity.

## Documentary text check (uploaded 80-B vs official CONFAZ HTML)

The following crosscheck is based on the original uploaded PDF's extracted one-page text and the official CONFAZ HTML, rather than on the non-retained Railway PDF response:

| Segment | PDF Extra 80-B content | CONFAZ official HTML | Conclusion |
| --- | --- | --- | --- |
| Dispatch | Despacho 16 of 25 Apr 2024, 391st extraordinary meeting | Convênio 15/24 reported as published by Despacho 16/24, DOU Extra 25 Apr 2024 | Publication reference corresponds |
| First clause | SCANC annex corrections and receipt, March 2024 events, COTEPE 44/24 and 53/24 | Same subjects/act references and period | Matches in material content |
| Second clause | Exceptional balance payment by 25 Apr 2024, offsetting amounts paid in excess | Same exceptional deadline and refund/offset clause | Matches in material content |
| Third clause | Waiver of applicable surcharges and fines connected to the described procedures | Same waiver statement | Matches in material content |
| Fourth clause | In force on publication of national ratification, with declared retroactive effects from 1 Apr 2024 | Same entry-into-force/retroactivity condition | Matches in material content |
| Ratification | Not part of the original Extra B PDF; separate later act | Ato Declaratório 10/24, published 2 May 2024, explicitly lists Convênio 15/24 | Separate ratification event confirmed |

This is a **documentary/manual comparison of substantive clause content**, not a guarantee of exact character-by-character normalized string equality, official HTTP-byte identity, original INLABS XML parsing, uninterrupted legal effect, or absence of later amendments.

## Timeline facts, without automatic legal CURRENT

| Event | Official source date |
| --- | --- |
| Original DOU publication | 2024-04-25 |
| Exceptional payment deadline stated in clause 2 | 2024-04-25 |
| National ratification published | 2024-05-02 |
| Date of entry into force according to clause 4 | 2024-05-02 |
| Retroactive effects stated in clause 4 | 2024-04-01 |
| Transactions/procedures addressed in clause 1 | Reference month March 2024 |

The **exceptional payment deadline predates the ratification publication**, and the convênio states retroactive effect. Record each independently. `exceptionalDeadlineBeforeReferenceDate=true` as of October 2026 is not `REVOKED`, `CURRENT` or `NON_CURRENT`; it is a past due date. Later changes/corrections/revocations were **not exhaustively checked**. The resulting status remains `legal_current_review_status=PENDING`.

## Validated pure software behavior

`dou-confaz-temporal-candidate.ts` takes official references and the identified dates, rejects impossible dates/mismatched ratification references and returns `DOU_RATIFICATION_TEMPORAL_FACTS_ONLY`, `grantsLegalCurrent=false`, `amendmentsAndRevocationReview=NOT_PERFORMED`. Its tests are synthetic reference-input validations, **not an independent assertion that later legislation has been exhaustively researched**.

No migrations, legal proofs, UI green badges, NCM global reprocessing, official document import, Railway service creation, production updates or merges occurred in this step.

## Next steps

1. Preserve the current DOU PDF original and CONFAZ references as distinct source records in the future design; do not claim the Railway PDF matches the uploaded PDF.
2. Obtain genuine INLABS XML/ZIP context for Despacho 16 and verify exact original act identity before source admission. Actual live GET + same-byte text correlation has not been performed against a real DOU archive in this chat.
3. Under separate design review, implement the proposed additive PostgreSQL metadata tables in `TAX13_R802_DOU_SOURCE_EVIDENCE_SQL_RFC.md` while keeping migration 048 unmodified. Do not store PDF binaries in PostgreSQL.
4. Audit amendments/revocations for Convênio 15/24 and verify operative effects per segment; run PG16/18 positive evidence tests, R7 and independent R9 before any legal CURRENT decision.
