-- ANAT-CONFIG-01 (issue tribusca-control#116, COORD decision of 28/10/2026): accessible anatomy configuration.
-- "Salvar configuração" validates and APPLIES a configuration in one administrative action: no freeze, no review by a
-- second administrator, no later publication. This REPLACES the double approval of 079 for this flow (the 079 tables and
-- functions are kept unchanged as history; nothing reads their activations). Saving affects only NEW analyses that read
-- the configuration; nothing here reprocesses or rewrites stored analyses or publications.
--
-- * anatomy_config_versions: immutable, numbered versions (profiles = ANAT-PROFILE/1 list, validated by the API with
--   the engine's own validator before this function is called; here: shape and hash binding, fail closed).
-- * anatomy_config_current: one row, the version in force. Optimistic concurrency: every write states the version it
--   was based on; a different current version -> anat:STALE_VERSION and nothing changes.
-- * anat_config_save / anat_config_restore: the ONLY write path (SECURITY DEFINER, owner anat_rules_writer, fixed
--   search_path, platform admin required through anat_actor()). Version, pointer and audit are written in the same
--   transaction: any failure leaves the previous version in force.
-- * Readers: radar_app (platform admins only, RLS) and radar_worker (the processing that consumes the configuration).

-- Audit policy: extends EXACTLY the policy of 078 with three ANAT events (same fail-closed pattern as 078/P-INT-03).
DO $$ DECLARE def text; raw text; cur jsonb; nxt jsonb; added text[]; BEGIN
 def := pg_get_functiondef(to_regprocedure('public.audit_event_policy(text,text)'));
 IF def IS NULL THEN RAISE EXCEPTION 'M_ANAT_CONFIG: audit_event_policy(text,text) not found; rebase it'; END IF;
 IF (length(def) - length(replace(def, '$json$', ''))) / length('$json$') IS DISTINCT FROM 2
    OR def !~ '\$json\$::jsonb -> \(p_action\|\|''\|''\|\|p_type\)' THEN
  RAISE EXCEPTION 'M_ANAT_CONFIG: audit_event_policy has an unrecognised format; rebase it';
 END IF;
 raw := substring(def FROM '\$json\$(.*)\$json\$');
 IF raw IS NULL THEN RAISE EXCEPTION 'M_ANAT_CONFIG: audit_event_policy JSON not found; rebase it'; END IF;
 BEGIN cur := raw::jsonb;
 EXCEPTION WHEN others THEN RAISE EXCEPTION 'M_ANAT_CONFIG: audit_event_policy JSON is invalid; rebase it'; END;
 IF jsonb_typeof(cur) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'M_ANAT_CONFIG: audit_event_policy JSON is not an object; rebase it'; END IF;
 nxt := $json${"COMPANY_CREATED|company":{"company_id":"uuid","is_active":"bool","version":"int","actor_redacted":"bool"},"COMPANY_UPDATED|company":{"company_id":"uuid","is_active":"bool","version":"int","actor_redacted":"bool"},"COMPANY_PURGED|company":{"purged":"bool","actor_redacted":"bool"},"ESTABLISHMENT_CREATED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"ESTABLISHMENT_UPDATED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"ESTABLISHMENT_DELETED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"COMPANY_TAX_PROFILE_UPDATED|company_tax_profile":{"company_id":"uuid","version":"int","actor_redacted":"bool"},"COMPANY_PRODUCT_PROFILE_UPDATED|company_product_profile":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"PLATFORM_ROLE_GRANTED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_REVOKED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_GRANTED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_REVOKED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"COLLECTION_FILTER_DRAFT_SAVED|collection_filter_policy":{"version":"int","revision":"int","actor_redacted":"bool"},"COLLECTION_FILTER_SIMULATION_REQUESTED|collection_filter_simulation":{"policyId":"uuid","version":"int","revision":"int","scope":["FULL_ARCHIVE","RECENT"],"reviewMode":["ALL","SAMPLE","NONE"],"actor_redacted":"bool"},"COLLECTION_FILTER_POLICY_APPROVED|collection_filter_policy":{"version":"int","revision":"int","simulationId":"uuid","actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_ADMIN_EDIT|collection_filter_policy":{"policyRevision":"int","action":["RULE_KEEP","RULE_DELETE","TERM_PUT","TERM_DELETE","ALIAS_PUT","ALIAS_DELETE","NEWTYPE_MERGE","NEWTYPE_KEEP"],"actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_RULE_CHANGED|collection_filter_type_rule":{"policyRevision":"int","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"],"actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_PURGE|collection_filter_type_rule":{"deletedCount":"int","deletedIds":"uuids","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"],"actor_redacted":"bool"},"L17_HIDDEN_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"],"actor_redacted":"bool"},"L17_RULE_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"],"actor_redacted":"bool"},"L18_PRESERVATION_RULES|collection_filter_policy":{"policyId":"uuid","policyRevision":"int","changedRuleCount":"int","addedStrongTerms":"int","actor_redacted":"bool"},"BASELINE_IMPORT_STARTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_FAILED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_VALIDATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_COMMITTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_CREATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_SUCCESSOR_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_SUCCESSOR_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_VALIDATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_CURATION_DRAFT_CREATED|taxonomy_curation":{"sourceReleaseId":"uuid","initialCuration":"bool","actor_redacted":"bool"},"TAXONOMY_CURATION_DIMENSION_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_DIMENSION_RETIRED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_CONCEPT_CREATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_CONCEPT_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_RUNTIME_SETTING_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_CREATED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_UPDATED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_DELETED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_IMPORT|taxonomy_curation":{"rows":"int","created":"int","updated":"int","errors":"int","actor_redacted":"bool"},"TAXONOMY_CURATION_GRID_SAVE|taxonomy_curation":{"created":"int","updated":"int","retired":"int","groupsCreated":"int","groupsUpdated":"int","actor_redacted":"bool"},"TAXONOMY_CURATION_PUBLISHED|taxonomy_curation":{"snapshotSha256":"sha256","actor_redacted":"bool"},"F2_T02_ACTUACAO_INITIALIZED|taxonomy_curation":{"seedSha256":"sha256","actor_redacted":"bool"},"F2_T02_ACTUACAO_CNAE_ORIGINS_IMPORTED|taxonomy_curation":{"sourceSha256":"sha256","projectionSha256":"sha256","originCount":"int","publicationRequested":"bool","actor_redacted":"bool"},"TAXONOMY_F2_SUGGESTIONS_CHANGED|taxonomy_curation":{"productsCount":"int","ncmsCount":"int","actor_redacted":"bool"},"F2_TAB03_CNAE_ACTUACOES_CHANGED|taxonomy_curation":{"published":"bool","actor_redacted":"bool"},"OFFICIAL_CATALOG_IMPORTED|official_catalog_edition":{"editionId":"uuid","inserted":"int","updated":"int","total":"int","sourceSha256":"sha256","actor_redacted":"bool"},"PUBLICATION_TAG_CURATED|publication":{"action":["ADD","REMOVE","RESTORE"],"actor_redacted":"bool"},"PUBLICATION_PRESENTATION_REFRESHED|publication_version":{"savedPageSha256":"sha256","htmlChars":"int","effectiveUntil":"date","actor_redacted":"bool"},"TAXONOMY_V1_1_DRAFT_CREATED|taxonomy_release":{"sourceReleaseId":"uuid","actor_redacted":"bool"},"TAXONOMY_V1_1_PUBLISHED|taxonomy_release":{"artifactSha256":"sha256","actor_redacted":"bool"},"MERGE_RFB_NORMAS_DOU_HISTORICAL|publication":{"douPublicationId":"uuid","rfbPublicationId":"uuid","douIdentityHash":"sha256","rfbIdentityHash":"sha256","publicationId":"uuid","identityHash":"sha256","rfbExternalId":["153678","153667","153640","153663","153636","153191","153192","153193","153120","153046","153059"],"douExternalId":["2026-09-23:DO1:180:24398395","2026-09-23:DO1:180:24398396","2026-09-22:DO1:179:24392992","2026-09-22:DO1E:179-B:24391984","2026-09-21:DO1E:178-B:24386620","2026-08-31:DO1:164:24304745","2026-08-31:DO1:164:24302161","2026-08-31:DO1:164:24302159","2026-08-26:DO1:161:24286739","2026-08-24:DO1:159:24272929","2026-08-24:DO1E:159-B:24280394"],"origins":"rfb_dou_origins","actor_redacted":"bool"},"TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED|taxonomy_curation":{"removedSynonyms":"int","rowsAffected":"int","actor_redacted":"bool"},"TAXONOMY_DRAFT_ORPHAN_RELATIONS_REMOVED|taxonomy_release":{"removedCount":"int","removedRelationIds":"uuids","preservedHistory":"bool","actor_redacted":"bool"},"ANAT_RULES_DRAFT_SAVED|anatomy_rules":{"draftId":"uuid","revision":"int","profileSetHash":"sha256","exampleSetHash":"sha256"},"ANAT_RULES_CANDIDATE_FROZEN|anatomy_rules":{"candidateId":"uuid","draftId":"uuid","profileSetHash":"sha256","exampleSetHash":"sha256","engineHash":"sha256"},"ANAT_RULES_SIMULATED|anatomy_rules":{"simulationId":"uuid","candidateId":"uuid","reportHash":"sha256","status":["COMPLETE","PARTIAL","CANCELLED","FAILED"],"passCount":"int","failCount":"int","partialCount":"int","cancelledCount":"int","inconclusiveCount":"int"},"ANAT_RULES_COMPARED|anatomy_rules":{"comparisonId":"uuid","candidateId":"uuid","comparisonHash":"sha256","baselineProfileSetHash":"sha256","differenceCount":"int"},"ANAT_RULES_REVIEWED|anatomy_rules":{"reviewId":"uuid","candidateId":"uuid","simulationId":"uuid","outcome":["APPROVED","REJECTED"],"comparisonCount":"int","decisionCount":"int"},"ANAT_RULES_ACTIVATION_PREVIEWED|anatomy_rules":{"previewId":"uuid","candidateId":"uuid","reviewId":"uuid","action":["ACTIVATE","ROLLBACK"],"intentHash":"sha256","expiresMinutes":"int"},"ANAT_RULES_ACTIVATED|anatomy_rules":{"activationId":"uuid","previousActivationId":"uuid","candidateId":"uuid","reviewId":"uuid","previewId":"uuid","action":["ACTIVATE","ROLLBACK"]},"ANAT_RULES_ATTEMPT_REJECTED|anatomy_rules":{"operation":["DRAFT_SAVE","FREEZE","SIMULATE","COMPARE","REVIEW","PREVIEW","CONFIRM"],"code":["STALE_REVISION","AUTHOR_CANNOT_REVIEW","REVIEW_INCOMPLETE","SIMULATION_NOT_PASSING","COMPARISON_MISMATCH","PREVIEW_EXPIRED","PREVIEW_CONSUMED","PREVIEW_STALE","ENGINE_MISMATCH","SIMULATION_UNAVAILABLE","LIMIT_EXCEEDED"],"targetId":"uuid"},"ANAT_RULES_CONFIG_SAVED|anatomy_rules":{"versionId":"uuid","version":"int","previousVersionId":"uuid","profileSetHash":"sha256","kind":["SAVE","RESTORE"],"restoredFromVersionId":"uuid"},"ANAT_RULES_CONFIG_REJECTED|anatomy_rules":{"operation":["SAVE","RESTORE"],"code":["STALE_VERSION","VERSION_NOT_FOUND"],"targetId":"uuid"},"ANAT_RULES_CONFIG_ANALYZED|anatomy_rules":{"analysisRecordId":"uuid","version":"int","documentHash":"sha256","appliedCorrectionCount":"int","staleCorrectionCount":"int"}}$json$::jsonb;
 SELECT array_agg(k ORDER BY k) INTO added FROM jsonb_object_keys(nxt) k WHERE k LIKE 'ANAT\_RULES\_CONFIG\_%';
 IF coalesce(array_length(added, 1), 0) <> 3 THEN RAISE EXCEPTION 'M_ANAT_CONFIG: expected exactly 3 ANAT config events'; END IF;
 IF cur IS DISTINCT FROM (nxt - added) THEN
  RAISE EXCEPTION 'M_ANAT_CONFIG: audit_event_policy in force differs from the policy this migration extends; rebase it';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.audit_event_policy(p_action TEXT,p_type TEXT)
RETURNS JSONB LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $policy$
 SELECT $json${"COMPANY_CREATED|company":{"company_id":"uuid","is_active":"bool","version":"int","actor_redacted":"bool"},"COMPANY_UPDATED|company":{"company_id":"uuid","is_active":"bool","version":"int","actor_redacted":"bool"},"COMPANY_PURGED|company":{"purged":"bool","actor_redacted":"bool"},"ESTABLISHMENT_CREATED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"ESTABLISHMENT_UPDATED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"ESTABLISHMENT_DELETED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"COMPANY_TAX_PROFILE_UPDATED|company_tax_profile":{"company_id":"uuid","version":"int","actor_redacted":"bool"},"COMPANY_PRODUCT_PROFILE_UPDATED|company_product_profile":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"PLATFORM_ROLE_GRANTED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_REVOKED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_GRANTED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_REVOKED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"COLLECTION_FILTER_DRAFT_SAVED|collection_filter_policy":{"version":"int","revision":"int","actor_redacted":"bool"},"COLLECTION_FILTER_SIMULATION_REQUESTED|collection_filter_simulation":{"policyId":"uuid","version":"int","revision":"int","scope":["FULL_ARCHIVE","RECENT"],"reviewMode":["ALL","SAMPLE","NONE"],"actor_redacted":"bool"},"COLLECTION_FILTER_POLICY_APPROVED|collection_filter_policy":{"version":"int","revision":"int","simulationId":"uuid","actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_ADMIN_EDIT|collection_filter_policy":{"policyRevision":"int","action":["RULE_KEEP","RULE_DELETE","TERM_PUT","TERM_DELETE","ALIAS_PUT","ALIAS_DELETE","NEWTYPE_MERGE","NEWTYPE_KEEP"],"actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_RULE_CHANGED|collection_filter_type_rule":{"policyRevision":"int","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"],"actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_PURGE|collection_filter_type_rule":{"deletedCount":"int","deletedIds":"uuids","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"],"actor_redacted":"bool"},"L17_HIDDEN_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"],"actor_redacted":"bool"},"L17_RULE_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"],"actor_redacted":"bool"},"L18_PRESERVATION_RULES|collection_filter_policy":{"policyId":"uuid","policyRevision":"int","changedRuleCount":"int","addedStrongTerms":"int","actor_redacted":"bool"},"BASELINE_IMPORT_STARTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_FAILED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_VALIDATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_COMMITTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_CREATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_SUCCESSOR_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_SUCCESSOR_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_VALIDATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_CURATION_DRAFT_CREATED|taxonomy_curation":{"sourceReleaseId":"uuid","initialCuration":"bool","actor_redacted":"bool"},"TAXONOMY_CURATION_DIMENSION_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_DIMENSION_RETIRED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_CONCEPT_CREATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_CONCEPT_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_RUNTIME_SETTING_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_CREATED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_UPDATED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_DELETED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_IMPORT|taxonomy_curation":{"rows":"int","created":"int","updated":"int","errors":"int","actor_redacted":"bool"},"TAXONOMY_CURATION_GRID_SAVE|taxonomy_curation":{"created":"int","updated":"int","retired":"int","groupsCreated":"int","groupsUpdated":"int","actor_redacted":"bool"},"TAXONOMY_CURATION_PUBLISHED|taxonomy_curation":{"snapshotSha256":"sha256","actor_redacted":"bool"},"F2_T02_ACTUACAO_INITIALIZED|taxonomy_curation":{"seedSha256":"sha256","actor_redacted":"bool"},"F2_T02_ACTUACAO_CNAE_ORIGINS_IMPORTED|taxonomy_curation":{"sourceSha256":"sha256","projectionSha256":"sha256","originCount":"int","publicationRequested":"bool","actor_redacted":"bool"},"TAXONOMY_F2_SUGGESTIONS_CHANGED|taxonomy_curation":{"productsCount":"int","ncmsCount":"int","actor_redacted":"bool"},"F2_TAB03_CNAE_ACTUACOES_CHANGED|taxonomy_curation":{"published":"bool","actor_redacted":"bool"},"OFFICIAL_CATALOG_IMPORTED|official_catalog_edition":{"editionId":"uuid","inserted":"int","updated":"int","total":"int","sourceSha256":"sha256","actor_redacted":"bool"},"PUBLICATION_TAG_CURATED|publication":{"action":["ADD","REMOVE","RESTORE"],"actor_redacted":"bool"},"PUBLICATION_PRESENTATION_REFRESHED|publication_version":{"savedPageSha256":"sha256","htmlChars":"int","effectiveUntil":"date","actor_redacted":"bool"},"TAXONOMY_V1_1_DRAFT_CREATED|taxonomy_release":{"sourceReleaseId":"uuid","actor_redacted":"bool"},"TAXONOMY_V1_1_PUBLISHED|taxonomy_release":{"artifactSha256":"sha256","actor_redacted":"bool"},"MERGE_RFB_NORMAS_DOU_HISTORICAL|publication":{"douPublicationId":"uuid","rfbPublicationId":"uuid","douIdentityHash":"sha256","rfbIdentityHash":"sha256","publicationId":"uuid","identityHash":"sha256","rfbExternalId":["153678","153667","153640","153663","153636","153191","153192","153193","153120","153046","153059"],"douExternalId":["2026-09-23:DO1:180:24398395","2026-09-23:DO1:180:24398396","2026-09-22:DO1:179:24392992","2026-09-22:DO1E:179-B:24391984","2026-09-21:DO1E:178-B:24386620","2026-08-31:DO1:164:24304745","2026-08-31:DO1:164:24302161","2026-08-31:DO1:164:24302159","2026-08-26:DO1:161:24286739","2026-08-24:DO1:159:24272929","2026-08-24:DO1E:159-B:24280394"],"origins":"rfb_dou_origins","actor_redacted":"bool"},"TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED|taxonomy_curation":{"removedSynonyms":"int","rowsAffected":"int","actor_redacted":"bool"},"TAXONOMY_DRAFT_ORPHAN_RELATIONS_REMOVED|taxonomy_release":{"removedCount":"int","removedRelationIds":"uuids","preservedHistory":"bool","actor_redacted":"bool"},"ANAT_RULES_DRAFT_SAVED|anatomy_rules":{"draftId":"uuid","revision":"int","profileSetHash":"sha256","exampleSetHash":"sha256"},"ANAT_RULES_CANDIDATE_FROZEN|anatomy_rules":{"candidateId":"uuid","draftId":"uuid","profileSetHash":"sha256","exampleSetHash":"sha256","engineHash":"sha256"},"ANAT_RULES_SIMULATED|anatomy_rules":{"simulationId":"uuid","candidateId":"uuid","reportHash":"sha256","status":["COMPLETE","PARTIAL","CANCELLED","FAILED"],"passCount":"int","failCount":"int","partialCount":"int","cancelledCount":"int","inconclusiveCount":"int"},"ANAT_RULES_COMPARED|anatomy_rules":{"comparisonId":"uuid","candidateId":"uuid","comparisonHash":"sha256","baselineProfileSetHash":"sha256","differenceCount":"int"},"ANAT_RULES_REVIEWED|anatomy_rules":{"reviewId":"uuid","candidateId":"uuid","simulationId":"uuid","outcome":["APPROVED","REJECTED"],"comparisonCount":"int","decisionCount":"int"},"ANAT_RULES_ACTIVATION_PREVIEWED|anatomy_rules":{"previewId":"uuid","candidateId":"uuid","reviewId":"uuid","action":["ACTIVATE","ROLLBACK"],"intentHash":"sha256","expiresMinutes":"int"},"ANAT_RULES_ACTIVATED|anatomy_rules":{"activationId":"uuid","previousActivationId":"uuid","candidateId":"uuid","reviewId":"uuid","previewId":"uuid","action":["ACTIVATE","ROLLBACK"]},"ANAT_RULES_ATTEMPT_REJECTED|anatomy_rules":{"operation":["DRAFT_SAVE","FREEZE","SIMULATE","COMPARE","REVIEW","PREVIEW","CONFIRM"],"code":["STALE_REVISION","AUTHOR_CANNOT_REVIEW","REVIEW_INCOMPLETE","SIMULATION_NOT_PASSING","COMPARISON_MISMATCH","PREVIEW_EXPIRED","PREVIEW_CONSUMED","PREVIEW_STALE","ENGINE_MISMATCH","SIMULATION_UNAVAILABLE","LIMIT_EXCEEDED"],"targetId":"uuid"},"ANAT_RULES_CONFIG_SAVED|anatomy_rules":{"versionId":"uuid","version":"int","previousVersionId":"uuid","profileSetHash":"sha256","kind":["SAVE","RESTORE"],"restoredFromVersionId":"uuid"},"ANAT_RULES_CONFIG_REJECTED|anatomy_rules":{"operation":["SAVE","RESTORE"],"code":["STALE_VERSION","VERSION_NOT_FOUND"],"targetId":"uuid"},"ANAT_RULES_CONFIG_ANALYZED|anatomy_rules":{"analysisRecordId":"uuid","version":"int","documentHash":"sha256","appliedCorrectionCount":"int","staleCorrectionCount":"int"}}$json$::jsonb -> (p_action||'|'||p_type)
$policy$;

CREATE TABLE anatomy_config_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version integer NOT NULL UNIQUE CHECK (version >= 1),
 kind text NOT NULL CHECK (kind IN ('save', 'restore')),
 profiles jsonb NOT NULL CHECK (jsonb_typeof(profiles) = 'array' AND jsonb_array_length(profiles) BETWEEN 1 AND 64),
 profile_set_hash text NOT NULL CHECK (profile_set_hash ~ '^[a-f0-9]{64}$'),
 -- Per-passage corrections (document scope), APPLIED on top of the engine result (which is kept unchanged) to the exact
 -- document version (document_hash) and passage identity (part_key) they were made on; elsewhere they are reported as
 -- stale and never applied. A correction is never widened into a rule.
 corrections jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(corrections) = 'array' AND jsonb_array_length(corrections) <= 500),
 note text CHECK (note IS NULL OR char_length(note) <= 2000),
 previous_version_id uuid REFERENCES anatomy_config_versions(id) ON DELETE RESTRICT,
 restored_from uuid REFERENCES anatomy_config_versions(id) ON DELETE RESTRICT,
 author uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((kind = 'restore') = (restored_from IS NOT NULL))
);
CREATE TABLE anatomy_config_current (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 version_id uuid NOT NULL UNIQUE REFERENCES anatomy_config_versions(id) ON DELETE RESTRICT,
 version integer NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Versions are history: never updated or deleted (079's anat_deny_change raises anat:IMMUTABLE).
CREATE TRIGGER anat_config_versions_immutable BEFORE UPDATE OR DELETE ON anatomy_config_versions FOR EACH ROW EXECUTE FUNCTION anat_deny_change();
CREATE FUNCTION anat_guard_config_current() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN PERFORM anat_fail('IMMUTABLE'); END IF;
 IF NOT EXISTS (SELECT 1 FROM anatomy_config_versions v WHERE v.id = NEW.version_id AND v.version = NEW.version) THEN PERFORM anat_fail('VERSION_NOT_FOUND'); END IF;
 IF TG_OP = 'UPDATE' AND NEW.version <= OLD.version THEN PERFORM anat_fail('STALE_VERSION'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_config_current BEFORE INSERT OR UPDATE OR DELETE ON anatomy_config_current FOR EACH ROW EXECUTE FUNCTION anat_guard_config_current();
CREATE TRIGGER anat_bind_actor BEFORE INSERT ON anatomy_config_versions FOR EACH ROW EXECUTE FUNCTION anat_bind_actor('author');

CREATE FUNCTION anat_config_assert_profiles(p jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) NOT BETWEEN 1 AND 64
    OR octet_length(p::text) > 64 * 64 * 1024
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE jsonb_typeof(e) <> 'object' OR e->>'profileVersion' IS DISTINCT FROM 'ANAT-PROFILE/1'
               OR jsonb_typeof(e->'scope') <> 'object' OR jsonb_typeof(e->'fields') <> 'object')
    OR (SELECT count(*) FROM jsonb_array_elements(p) e WHERE e->'scope'->>'level' = 'default') <> 1 THEN
  PERFORM anat_fail('INVALID_PROFILE', '22023');
 END IF;
END $$;
CREATE FUNCTION anat_config_assert_corrections(p jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) > 500
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE jsonb_typeof(e) <> 'object'
               OR NOT (e ?& ARRAY['documentId','documentHash','partKey','expected','reason','author','createdAt'])
               OR e->>'documentHash' !~ '^[a-f0-9]{64}$' OR e->>'partKey' !~ '^[a-f0-9]{16}$' OR char_length(btrim(e->>'reason')) NOT BETWEEN 3 AND 500
               OR e->>'expected' NOT IN ('operative','historical','editorial_note','amendment','structure','ambiguous'))
    OR (SELECT count(*) FROM jsonb_array_elements(p) e) <> (SELECT count(DISTINCT (e->>'documentId', e->>'documentHash', e->>'partKey')) FROM jsonb_array_elements(p) e) THEN
  PERFORM anat_fail('INVALID_CORRECTION', '22023');
 END IF;
END $$;

-- p_expected_version: the version the administrator saw (0 = none saved yet: the shipped defaults were in force).
CREATE FUNCTION anat_config_write(p_kind text, p_expected_version integer, p_profiles jsonb, p_corrections jsonb, p_hash text,
 p_note text, p_restored_from uuid, p_correlation uuid, OUT version_id uuid, OUT version integer)
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := anat_actor(); v_cur anatomy_config_current; v_next integer;
BEGIN
 PERFORM anat_config_assert_profiles(p_profiles);
 PERFORM anat_config_assert_corrections(p_corrections);
 IF p_hash IS DISTINCT FROM anat_sha256(p_profiles) THEN PERFORM anat_fail('HASH_MISMATCH', '22023'); END IF;
 -- One writer at a time: the advisory lock serialises the first save (no row to lock yet) as well.
 PERFORM pg_advisory_xact_lock(hashtextextended('anat-config', 0));
 SELECT * INTO v_cur FROM anatomy_config_current WHERE singleton FOR UPDATE;
 IF coalesce(v_cur.version, 0) IS DISTINCT FROM p_expected_version THEN PERFORM anat_fail('STALE_VERSION'); END IF;
 -- On save, every correction that is not already in the version in force must be authored by the session user.
 IF p_kind = 'save' AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_corrections) e
     WHERE NOT EXISTS (SELECT 1 FROM anatomy_config_versions pv, jsonb_array_elements(pv.corrections) o WHERE pv.id = v_cur.version_id AND o = e)
       AND e->>'author' IS DISTINCT FROM v_actor::text) THEN
  PERFORM anat_fail('ACTOR_MISMATCH', '42501');
 END IF;
 v_next := coalesce((SELECT max(v.version) FROM anatomy_config_versions v), 0) + 1;
 INSERT INTO anatomy_config_versions (version, kind, profiles, profile_set_hash, corrections, note, previous_version_id, restored_from, author)
 VALUES (v_next, p_kind, p_profiles, p_hash, p_corrections, nullif(btrim(p_note), ''), v_cur.version_id, p_restored_from, v_actor)
 RETURNING anatomy_config_versions.id, anatomy_config_versions.version INTO version_id, version;
 IF v_cur.version_id IS NULL THEN
  INSERT INTO anatomy_config_current (singleton, version_id, version) VALUES (true, version_id, version);
 ELSE
  UPDATE anatomy_config_current c SET version_id = anat_config_write.version_id, version = anat_config_write.version, updated_at = now() WHERE c.singleton;
 END IF;
 PERFORM anat_audit('ANAT_RULES_CONFIG_SAVED', version_id, jsonb_build_object('versionId', version_id, 'version', version,
  'previousVersionId', v_cur.version_id, 'profileSetHash', p_hash, 'kind', upper(p_kind), 'restoredFromVersionId', p_restored_from), p_correlation);
END $$;

CREATE FUNCTION anat_config_save(p_expected_version integer, p_profiles jsonb, p_corrections jsonb, p_hash text, p_note text, p_correlation uuid,
 OUT version_id uuid, OUT version integer) LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT w.version_id, w.version FROM anat_config_write('save', p_expected_version, p_profiles, p_corrections, p_hash, p_note, NULL, p_correlation) w $$;

-- Restore = a NEW version with the content of an earlier one (history is never rewritten); audited as RESTORE.
CREATE FUNCTION anat_config_restore(p_expected_version integer, p_source uuid, p_note text, p_correlation uuid,
 OUT version_id uuid, OUT version integer) LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s anatomy_config_versions;
BEGIN
 PERFORM anat_actor();
 SELECT * INTO s FROM anatomy_config_versions v WHERE v.id = p_source;
 IF NOT FOUND THEN PERFORM anat_fail('VERSION_NOT_FOUND'); END IF;
 SELECT w.version_id, w.version INTO version_id, version
  FROM anat_config_write('restore', p_expected_version, s.profiles, s.corrections, s.profile_set_hash, p_note, s.id, p_correlation) w;
END $$;

CREATE FUNCTION anat_config_audit_attempt(p_operation text, p_code text, p_target uuid, p_correlation uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT anat_audit('ANAT_RULES_CONFIG_REJECTED', coalesce(p_target, p_correlation),
  jsonb_build_object('operation', p_operation, 'code', p_code, 'targetId', p_target), p_correlation) $$;

-- New analyses of ONE document with the configuration in force (the consumer). Immutable history: earlier analyses
-- are kept; each row states the document version, the configuration version and the corrections applied or stale.
CREATE TABLE anatomy_config_analyses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 document_id text NOT NULL CHECK (char_length(document_id) BETWEEN 1 AND 64),
 document_version text NOT NULL CHECK (char_length(document_version) BETWEEN 1 AND 32),
 document_hash text NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
 config_version integer NOT NULL CHECK (config_version >= 0),
 config_version_id uuid REFERENCES anatomy_config_versions(id) ON DELETE RESTRICT,
 engine_analysis_id text NOT NULL CHECK (engine_analysis_id ~ '^[a-f0-9]{64}$'),
 output_hash text NOT NULL CHECK (output_hash ~ '^[a-f0-9]{64}$'),
 corrections_applied jsonb NOT NULL CHECK (jsonb_typeof(corrections_applied) = 'array'),
 corrections_stale jsonb NOT NULL CHECK (jsonb_typeof(corrections_stale) = 'array'),
 summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 1048576),
 requested_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((config_version = 0) = (config_version_id IS NULL))
);
CREATE INDEX anatomy_config_analyses_document ON anatomy_config_analyses(document_id, created_at DESC);
CREATE TRIGGER anat_config_analyses_immutable BEFORE UPDATE OR DELETE ON anatomy_config_analyses FOR EACH ROW EXECUTE FUNCTION anat_deny_change();
CREATE TRIGGER anat_bind_actor BEFORE INSERT ON anatomy_config_analyses FOR EACH ROW EXECUTE FUNCTION anat_bind_actor('requested_by');

-- Records an analysis only if it was made with the version still in force (else STALE_VERSION and nothing is written).
CREATE FUNCTION anat_config_record_analysis(p_expected_version integer, p_document_id text, p_document_version text, p_document_hash text,
 p_engine_analysis_id text, p_output_hash text, p_applied jsonb, p_stale jsonb, p_summary jsonb, p_correlation uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_actor uuid := anat_actor(); v_cur anatomy_config_current; v_id uuid;
BEGIN
 -- CONFIG-R2-03: the SAME advisory key as anat_config_write, in shared mode. Saves (exclusive) and records (shared)
 -- are serialised even before the first save, when there is no anatomy_config_current row for FOR SHARE to lock;
 -- concurrent records do not block each other.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('anat-config', 0));
 SELECT * INTO v_cur FROM anatomy_config_current WHERE singleton FOR SHARE;
 IF coalesce(v_cur.version, 0) IS DISTINCT FROM p_expected_version THEN PERFORM anat_fail('STALE_VERSION'); END IF;
 INSERT INTO anatomy_config_analyses (document_id, document_version, document_hash, config_version, config_version_id, engine_analysis_id, output_hash,
  corrections_applied, corrections_stale, summary, requested_by)
 VALUES (p_document_id, p_document_version, p_document_hash, p_expected_version, v_cur.version_id, p_engine_analysis_id, p_output_hash,
  p_applied, p_stale, p_summary, v_actor) RETURNING id INTO v_id;
 PERFORM anat_audit('ANAT_RULES_CONFIG_ANALYZED', v_id, jsonb_build_object('analysisRecordId', v_id, 'version', p_expected_version, 'documentHash', p_document_hash,
  'appliedCorrectionCount', jsonb_array_length(p_applied), 'staleCorrectionCount', jsonb_array_length(p_stale)), p_correlation);
 RETURN v_id;
END $$;

-- Privileges: same boundary as 079. PUBLIC/curator nothing; radar_app SELECT (platform admins) + EXECUTE entry points;
-- radar_worker SELECT (the consumer); anat_rules_writer the DML the entry points need.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['anatomy_config_versions','anatomy_config_current','anatomy_config_analyses'] LOOP
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator, anat_rules_writer', t);
  EXECUTE format('GRANT SELECT ON %I TO radar_app, radar_worker', t);
  EXECUTE format('GRANT SELECT, INSERT ON %I TO anat_rules_writer', t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY anat_admin_select ON %I FOR SELECT TO radar_app USING (app_user_is_platform_admin())', t);
  EXECUTE format('CREATE POLICY anat_worker_select ON %I FOR SELECT TO radar_worker USING (true)', t);
  EXECUTE format('CREATE POLICY anat_writer_all ON %I TO anat_rules_writer USING (true) WITH CHECK (true)', t);
 END LOOP;
END $$;
GRANT UPDATE (version_id, version, updated_at) ON anatomy_config_current TO anat_rules_writer;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('anat_guard_config_current','anat_config_assert_profiles','anat_config_assert_corrections','anat_config_write',
                     'anat_config_save','anat_config_restore','anat_config_audit_attempt','anat_config_record_analysis') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anat_rules_writer', f);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('anat_config_save','anat_config_restore','anat_config_audit_attempt','anat_config_record_analysis') LOOP
  EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', f);
  EXECUTE format('ALTER FUNCTION %s OWNER TO anat_rules_writer', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO radar_app', f);
 END LOOP;
END $$;
