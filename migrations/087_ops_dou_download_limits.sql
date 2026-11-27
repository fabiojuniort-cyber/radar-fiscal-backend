-- OPS-DL-01: extend the audit policy without changing any existing entry.
DO $$ DECLARE def text; raw text; cur jsonb; nxt jsonb; added text[]; BEGIN
 def := pg_get_functiondef(to_regprocedure('public.audit_event_policy(text,text)'));
 IF def IS NULL THEN RAISE EXCEPTION 'M_OPS_DOU_LIMITS: audit_event_policy(text,text) not found; rebase it'; END IF;
 IF (length(def) - length(replace(def, '$json$', ''))) / length('$json$') IS DISTINCT FROM 2
    OR def !~ '\$json\$::jsonb -> \(p_action\|\|''\|''\|\|p_type\)' THEN
  RAISE EXCEPTION 'M_OPS_DOU_LIMITS: audit_event_policy has an unrecognised format; rebase it';
 END IF;
 raw := substring(def FROM '\$json\$(.*)\$json\$');
 IF raw IS NULL THEN RAISE EXCEPTION 'M_OPS_DOU_LIMITS: audit_event_policy JSON not found; rebase it'; END IF;
 BEGIN cur := raw::jsonb;
 EXCEPTION WHEN others THEN RAISE EXCEPTION 'M_OPS_DOU_LIMITS: audit_event_policy JSON is invalid; rebase it'; END;
 IF jsonb_typeof(cur) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'M_OPS_DOU_LIMITS: audit_event_policy JSON is not an object; rebase it'; END IF;
 nxt := $json${"COMPANY_CREATED|company":{"company_id":"uuid","is_active":"bool","version":"int","actor_redacted":"bool"},"COMPANY_UPDATED|company":{"company_id":"uuid","is_active":"bool","version":"int","actor_redacted":"bool"},"COMPANY_PURGED|company":{"purged":"bool","actor_redacted":"bool"},"ESTABLISHMENT_CREATED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"ESTABLISHMENT_UPDATED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"ESTABLISHMENT_DELETED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"COMPANY_TAX_PROFILE_UPDATED|company_tax_profile":{"company_id":"uuid","version":"int","actor_redacted":"bool"},"COMPANY_PRODUCT_PROFILE_UPDATED|company_product_profile":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"PLATFORM_ROLE_GRANTED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_REVOKED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_GRANTED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_REVOKED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"COLLECTION_FILTER_DRAFT_SAVED|collection_filter_policy":{"version":"int","revision":"int","actor_redacted":"bool"},"COLLECTION_FILTER_SIMULATION_REQUESTED|collection_filter_simulation":{"policyId":"uuid","version":"int","revision":"int","scope":["FULL_ARCHIVE","RECENT"],"reviewMode":["ALL","SAMPLE","NONE"],"actor_redacted":"bool"},"COLLECTION_FILTER_POLICY_APPROVED|collection_filter_policy":{"version":"int","revision":"int","simulationId":"uuid","actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_ADMIN_EDIT|collection_filter_policy":{"policyRevision":"int","action":["RULE_KEEP","RULE_DELETE","TERM_PUT","TERM_DELETE","ALIAS_PUT","ALIAS_DELETE","NEWTYPE_MERGE","NEWTYPE_KEEP"],"actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_RULE_CHANGED|collection_filter_type_rule":{"policyRevision":"int","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"],"actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_PURGE|collection_filter_type_rule":{"deletedCount":"int","deletedIds":"uuids","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"],"actor_redacted":"bool"},"L17_HIDDEN_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"],"actor_redacted":"bool"},"L17_RULE_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"],"actor_redacted":"bool"},"L18_PRESERVATION_RULES|collection_filter_policy":{"policyId":"uuid","policyRevision":"int","changedRuleCount":"int","addedStrongTerms":"int","actor_redacted":"bool"},"BASELINE_IMPORT_STARTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_FAILED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_VALIDATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_COMMITTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_CREATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_SUCCESSOR_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_SUCCESSOR_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_VALIDATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_CURATION_DRAFT_CREATED|taxonomy_curation":{"sourceReleaseId":"uuid","initialCuration":"bool","actor_redacted":"bool"},"TAXONOMY_CURATION_DIMENSION_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_DIMENSION_RETIRED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_CONCEPT_CREATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_CONCEPT_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_RUNTIME_SETTING_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_CREATED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_UPDATED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_DELETED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_IMPORT|taxonomy_curation":{"rows":"int","created":"int","updated":"int","errors":"int","actor_redacted":"bool"},"TAXONOMY_CURATION_GRID_SAVE|taxonomy_curation":{"created":"int","updated":"int","retired":"int","groupsCreated":"int","groupsUpdated":"int","actor_redacted":"bool"},"TAXONOMY_CURATION_PUBLISHED|taxonomy_curation":{"snapshotSha256":"sha256","actor_redacted":"bool"},"F2_T02_ACTUACAO_INITIALIZED|taxonomy_curation":{"seedSha256":"sha256","actor_redacted":"bool"},"F2_T02_ACTUACAO_CNAE_ORIGINS_IMPORTED|taxonomy_curation":{"sourceSha256":"sha256","projectionSha256":"sha256","originCount":"int","publicationRequested":"bool","actor_redacted":"bool"},"TAXONOMY_F2_SUGGESTIONS_CHANGED|taxonomy_curation":{"productsCount":"int","ncmsCount":"int","actor_redacted":"bool"},"F2_TAB03_CNAE_ACTUACOES_CHANGED|taxonomy_curation":{"published":"bool","actor_redacted":"bool"},"OFFICIAL_CATALOG_IMPORTED|official_catalog_edition":{"editionId":"uuid","inserted":"int","updated":"int","total":"int","sourceSha256":"sha256","actor_redacted":"bool"},"PUBLICATION_TAG_CURATED|publication":{"action":["ADD","REMOVE","RESTORE"],"actor_redacted":"bool"},"PUBLICATION_PRESENTATION_REFRESHED|publication_version":{"savedPageSha256":"sha256","htmlChars":"int","effectiveUntil":"date","actor_redacted":"bool"},"TAXONOMY_V1_1_DRAFT_CREATED|taxonomy_release":{"sourceReleaseId":"uuid","actor_redacted":"bool"},"TAXONOMY_V1_1_PUBLISHED|taxonomy_release":{"artifactSha256":"sha256","actor_redacted":"bool"},"MERGE_RFB_NORMAS_DOU_HISTORICAL|publication":{"douPublicationId":"uuid","rfbPublicationId":"uuid","douIdentityHash":"sha256","rfbIdentityHash":"sha256","publicationId":"uuid","identityHash":"sha256","rfbExternalId":["153678","153667","153640","153663","153636","153191","153192","153193","153120","153046","153059"],"douExternalId":["2026-09-23:DO1:180:24398395","2026-09-23:DO1:180:24398396","2026-09-22:DO1:179:24392992","2026-09-22:DO1E:179-B:24391984","2026-09-21:DO1E:178-B:24386620","2026-08-31:DO1:164:24304745","2026-08-31:DO1:164:24302161","2026-08-31:DO1:164:24302159","2026-08-26:DO1:161:24286739","2026-08-24:DO1:159:24272929","2026-08-24:DO1E:159-B:24280394"],"origins":"rfb_dou_origins","actor_redacted":"bool"},"TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED|taxonomy_curation":{"removedSynonyms":"int","rowsAffected":"int","actor_redacted":"bool"},"TAXONOMY_DRAFT_ORPHAN_RELATIONS_REMOVED|taxonomy_release":{"removedCount":"int","removedRelationIds":"uuids","preservedHistory":"bool","actor_redacted":"bool"},"ANAT_RULES_DRAFT_SAVED|anatomy_rules":{"draftId":"uuid","revision":"int","profileSetHash":"sha256","exampleSetHash":"sha256"},"ANAT_RULES_CANDIDATE_FROZEN|anatomy_rules":{"candidateId":"uuid","draftId":"uuid","profileSetHash":"sha256","exampleSetHash":"sha256","engineHash":"sha256"},"ANAT_RULES_SIMULATED|anatomy_rules":{"simulationId":"uuid","candidateId":"uuid","reportHash":"sha256","status":["COMPLETE","PARTIAL","CANCELLED","FAILED"],"passCount":"int","failCount":"int","partialCount":"int","cancelledCount":"int","inconclusiveCount":"int"},"ANAT_RULES_COMPARED|anatomy_rules":{"comparisonId":"uuid","candidateId":"uuid","comparisonHash":"sha256","baselineProfileSetHash":"sha256","differenceCount":"int"},"ANAT_RULES_REVIEWED|anatomy_rules":{"reviewId":"uuid","candidateId":"uuid","simulationId":"uuid","outcome":["APPROVED","REJECTED"],"comparisonCount":"int","decisionCount":"int"},"ANAT_RULES_ACTIVATION_PREVIEWED|anatomy_rules":{"previewId":"uuid","candidateId":"uuid","reviewId":"uuid","action":["ACTIVATE","ROLLBACK"],"intentHash":"sha256","expiresMinutes":"int"},"ANAT_RULES_ACTIVATED|anatomy_rules":{"activationId":"uuid","previousActivationId":"uuid","candidateId":"uuid","reviewId":"uuid","previewId":"uuid","action":["ACTIVATE","ROLLBACK"]},"ANAT_RULES_ATTEMPT_REJECTED|anatomy_rules":{"operation":["DRAFT_SAVE","FREEZE","SIMULATE","COMPARE","REVIEW","PREVIEW","CONFIRM"],"code":["STALE_REVISION","AUTHOR_CANNOT_REVIEW","REVIEW_INCOMPLETE","SIMULATION_NOT_PASSING","COMPARISON_MISMATCH","PREVIEW_EXPIRED","PREVIEW_CONSUMED","PREVIEW_STALE","ENGINE_MISMATCH","SIMULATION_UNAVAILABLE","LIMIT_EXCEEDED"],"targetId":"uuid"},"ANAT_RULES_CONFIG_SAVED|anatomy_rules":{"versionId":"uuid","version":"int","previousVersionId":"uuid","profileSetHash":"sha256","kind":["SAVE","RESTORE"],"restoredFromVersionId":"uuid"},"ANAT_RULES_CONFIG_REJECTED|anatomy_rules":{"operation":["SAVE","RESTORE"],"code":["STALE_VERSION","VERSION_NOT_FOUND"],"targetId":"uuid"},"ANAT_RULES_CONFIG_ANALYZED|anatomy_rules":{"analysisRecordId":"uuid","version":"int","documentHash":"sha256","appliedCorrectionCount":"int","staleCorrectionCount":"int"},"DOU_DOWNLOAD_LIMITS_UPDATED|sources.connector_config":{"pdfMiB":"int","zipMiB":"int","expandedZipMiB":"int","xmlEntryMiB":"int"}}$json$::jsonb;
 added := ARRAY['DOU_DOWNLOAD_LIMITS_UPDATED|sources.connector_config'];
 IF cur IS DISTINCT FROM (nxt - added) THEN
  RAISE EXCEPTION 'M_OPS_DOU_LIMITS: audit_event_policy in force differs from the policy this migration extends; rebase it';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.audit_event_policy(p_action TEXT,p_type TEXT)
RETURNS JSONB LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $policy$
 SELECT $json${"COMPANY_CREATED|company":{"company_id":"uuid","is_active":"bool","version":"int","actor_redacted":"bool"},"COMPANY_UPDATED|company":{"company_id":"uuid","is_active":"bool","version":"int","actor_redacted":"bool"},"COMPANY_PURGED|company":{"purged":"bool","actor_redacted":"bool"},"ESTABLISHMENT_CREATED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"ESTABLISHMENT_UPDATED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"ESTABLISHMENT_DELETED|establishment":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"COMPANY_TAX_PROFILE_UPDATED|company_tax_profile":{"company_id":"uuid","version":"int","actor_redacted":"bool"},"COMPANY_PRODUCT_PROFILE_UPDATED|company_product_profile":{"company_id":"uuid","is_active":"bool","actor_redacted":"bool"},"PLATFORM_ROLE_GRANTED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_REVOKED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_GRANTED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"PLATFORM_ROLE_REVOKED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"],"actor_redacted":"bool"},"COLLECTION_FILTER_DRAFT_SAVED|collection_filter_policy":{"version":"int","revision":"int","actor_redacted":"bool"},"COLLECTION_FILTER_SIMULATION_REQUESTED|collection_filter_simulation":{"policyId":"uuid","version":"int","revision":"int","scope":["FULL_ARCHIVE","RECENT"],"reviewMode":["ALL","SAMPLE","NONE"],"actor_redacted":"bool"},"COLLECTION_FILTER_POLICY_APPROVED|collection_filter_policy":{"version":"int","revision":"int","simulationId":"uuid","actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_ADMIN_EDIT|collection_filter_policy":{"policyRevision":"int","action":["RULE_KEEP","RULE_DELETE","TERM_PUT","TERM_DELETE","ALIAS_PUT","ALIAS_DELETE","NEWTYPE_MERGE","NEWTYPE_KEEP"],"actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_RULE_CHANGED|collection_filter_type_rule":{"policyRevision":"int","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"],"actor_redacted":"bool"},"COLLECTION_FILTER_DIRECT_PURGE|collection_filter_type_rule":{"deletedCount":"int","deletedIds":"uuids","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"],"actor_redacted":"bool"},"L17_HIDDEN_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"],"actor_redacted":"bool"},"L17_RULE_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"],"actor_redacted":"bool"},"L18_PRESERVATION_RULES|collection_filter_policy":{"policyId":"uuid","policyRevision":"int","changedRuleCount":"int","addedStrongTerms":"int","actor_redacted":"bool"},"BASELINE_IMPORT_STARTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_FAILED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_VALIDATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"BASELINE_IMPORT_COMMITTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_CREATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_SUCCESSOR_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_SUCCESSOR_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_RELEASE_VALIDATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"],"actor_redacted":"bool"},"TAXONOMY_CURATION_DRAFT_CREATED|taxonomy_curation":{"sourceReleaseId":"uuid","initialCuration":"bool","actor_redacted":"bool"},"TAXONOMY_CURATION_DIMENSION_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_DIMENSION_RETIRED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_CONCEPT_CREATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_CONCEPT_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_RUNTIME_SETTING_UPDATED|taxonomy_curation":{"actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_CREATED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_UPDATED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_GROUP_DELETED|taxonomy_curation":{"groupId":"uuid","actor_redacted":"bool"},"TAXONOMY_CURATION_IMPORT|taxonomy_curation":{"rows":"int","created":"int","updated":"int","errors":"int","actor_redacted":"bool"},"TAXONOMY_CURATION_GRID_SAVE|taxonomy_curation":{"created":"int","updated":"int","retired":"int","groupsCreated":"int","groupsUpdated":"int","actor_redacted":"bool"},"TAXONOMY_CURATION_PUBLISHED|taxonomy_curation":{"snapshotSha256":"sha256","actor_redacted":"bool"},"F2_T02_ACTUACAO_INITIALIZED|taxonomy_curation":{"seedSha256":"sha256","actor_redacted":"bool"},"F2_T02_ACTUACAO_CNAE_ORIGINS_IMPORTED|taxonomy_curation":{"sourceSha256":"sha256","projectionSha256":"sha256","originCount":"int","publicationRequested":"bool","actor_redacted":"bool"},"TAXONOMY_F2_SUGGESTIONS_CHANGED|taxonomy_curation":{"productsCount":"int","ncmsCount":"int","actor_redacted":"bool"},"F2_TAB03_CNAE_ACTUACOES_CHANGED|taxonomy_curation":{"published":"bool","actor_redacted":"bool"},"OFFICIAL_CATALOG_IMPORTED|official_catalog_edition":{"editionId":"uuid","inserted":"int","updated":"int","total":"int","sourceSha256":"sha256","actor_redacted":"bool"},"PUBLICATION_TAG_CURATED|publication":{"action":["ADD","REMOVE","RESTORE"],"actor_redacted":"bool"},"PUBLICATION_PRESENTATION_REFRESHED|publication_version":{"savedPageSha256":"sha256","htmlChars":"int","effectiveUntil":"date","actor_redacted":"bool"},"TAXONOMY_V1_1_DRAFT_CREATED|taxonomy_release":{"sourceReleaseId":"uuid","actor_redacted":"bool"},"TAXONOMY_V1_1_PUBLISHED|taxonomy_release":{"artifactSha256":"sha256","actor_redacted":"bool"},"MERGE_RFB_NORMAS_DOU_HISTORICAL|publication":{"douPublicationId":"uuid","rfbPublicationId":"uuid","douIdentityHash":"sha256","rfbIdentityHash":"sha256","publicationId":"uuid","identityHash":"sha256","rfbExternalId":["153678","153667","153640","153663","153636","153191","153192","153193","153120","153046","153059"],"douExternalId":["2026-09-23:DO1:180:24398395","2026-09-23:DO1:180:24398396","2026-09-22:DO1:179:24392992","2026-09-22:DO1E:179-B:24391984","2026-09-21:DO1E:178-B:24386620","2026-08-31:DO1:164:24304745","2026-08-31:DO1:164:24302161","2026-08-31:DO1:164:24302159","2026-08-26:DO1:161:24286739","2026-08-24:DO1:159:24272929","2026-08-24:DO1E:159-B:24280394"],"origins":"rfb_dou_origins","actor_redacted":"bool"},"TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED|taxonomy_curation":{"removedSynonyms":"int","rowsAffected":"int","actor_redacted":"bool"},"TAXONOMY_DRAFT_ORPHAN_RELATIONS_REMOVED|taxonomy_release":{"removedCount":"int","removedRelationIds":"uuids","preservedHistory":"bool","actor_redacted":"bool"},"ANAT_RULES_DRAFT_SAVED|anatomy_rules":{"draftId":"uuid","revision":"int","profileSetHash":"sha256","exampleSetHash":"sha256"},"ANAT_RULES_CANDIDATE_FROZEN|anatomy_rules":{"candidateId":"uuid","draftId":"uuid","profileSetHash":"sha256","exampleSetHash":"sha256","engineHash":"sha256"},"ANAT_RULES_SIMULATED|anatomy_rules":{"simulationId":"uuid","candidateId":"uuid","reportHash":"sha256","status":["COMPLETE","PARTIAL","CANCELLED","FAILED"],"passCount":"int","failCount":"int","partialCount":"int","cancelledCount":"int","inconclusiveCount":"int"},"ANAT_RULES_COMPARED|anatomy_rules":{"comparisonId":"uuid","candidateId":"uuid","comparisonHash":"sha256","baselineProfileSetHash":"sha256","differenceCount":"int"},"ANAT_RULES_REVIEWED|anatomy_rules":{"reviewId":"uuid","candidateId":"uuid","simulationId":"uuid","outcome":["APPROVED","REJECTED"],"comparisonCount":"int","decisionCount":"int"},"ANAT_RULES_ACTIVATION_PREVIEWED|anatomy_rules":{"previewId":"uuid","candidateId":"uuid","reviewId":"uuid","action":["ACTIVATE","ROLLBACK"],"intentHash":"sha256","expiresMinutes":"int"},"ANAT_RULES_ACTIVATED|anatomy_rules":{"activationId":"uuid","previousActivationId":"uuid","candidateId":"uuid","reviewId":"uuid","previewId":"uuid","action":["ACTIVATE","ROLLBACK"]},"ANAT_RULES_ATTEMPT_REJECTED|anatomy_rules":{"operation":["DRAFT_SAVE","FREEZE","SIMULATE","COMPARE","REVIEW","PREVIEW","CONFIRM"],"code":["STALE_REVISION","AUTHOR_CANNOT_REVIEW","REVIEW_INCOMPLETE","SIMULATION_NOT_PASSING","COMPARISON_MISMATCH","PREVIEW_EXPIRED","PREVIEW_CONSUMED","PREVIEW_STALE","ENGINE_MISMATCH","SIMULATION_UNAVAILABLE","LIMIT_EXCEEDED"],"targetId":"uuid"},"ANAT_RULES_CONFIG_SAVED|anatomy_rules":{"versionId":"uuid","version":"int","previousVersionId":"uuid","profileSetHash":"sha256","kind":["SAVE","RESTORE"],"restoredFromVersionId":"uuid"},"ANAT_RULES_CONFIG_REJECTED|anatomy_rules":{"operation":["SAVE","RESTORE"],"code":["STALE_VERSION","VERSION_NOT_FOUND"],"targetId":"uuid"},"ANAT_RULES_CONFIG_ANALYZED|anatomy_rules":{"analysisRecordId":"uuid","version":"int","documentHash":"sha256","appliedCorrectionCount":"int","staleCorrectionCount":"int"},"DOU_DOWNLOAD_LIMITS_UPDATED|sources.connector_config":{"pdfMiB":"int","zipMiB":"int","expandedZipMiB":"int","xmlEntryMiB":"int"}}$json$::jsonb -> (p_action||'|'||p_type)
$policy$;

-- OPS-DL-01 R2: isolated settings-gateway, not a TAX13 / 049 migration.
-- This migration creates NO active credential and authorizes NO collector action.
-- Provision dedicated password + signature secret by the ops provisioning flow.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='radar_dou_limits_runtime') THEN
   CREATE ROLE radar_dou_limits_runtime NOLOGIN NOINHERIT
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END
$role$;
ALTER ROLE radar_dou_limits_runtime NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO radar_dou_limits_runtime;
DO $connect$
BEGIN
 EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO radar_dou_limits_runtime',current_database());
END
$connect$;

-- Only the migration owner/provisioning superuser can read a signing secret.
-- Never store the secret in source config, audit rows, HTTP logs, GUCs or PRs.
CREATE TABLE public.ops_dou_limits_signing_keys(
 key_id text PRIMARY KEY CHECK(key_id='v1'),
 key_bytes bytea NOT NULL CHECK(pg_catalog.octet_length(key_bytes)=32),
 installed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON public.ops_dou_limits_signing_keys FROM PUBLIC,
 radar_app,radar_worker,radar_dou_limits_runtime;

-- Same transaction as settings UPDATE; prevents replay of valid signed requests.
CREATE TABLE public.ops_dou_limits_used_nonces(
 nonce uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
 issued_at bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON public.ops_dou_limits_used_nonces FROM PUBLIC,
 radar_app,radar_worker,radar_dou_limits_runtime;

-- Authenticated API signs the immutable values: no trust in mutable app.user_id.
-- A stolen generic radar_app_runtime SQL connection has no EXECUTE permission.
CREATE FUNCTION public.platform_admin_set_dou_limits(
 p_actor uuid,p_limits jsonb,p_issued_at bigint,p_nonce uuid,p_mac text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,pg_temp AS $gate$
DECLARE
 v_key bytea;
 v_message text;
 v_actor uuid;
 v_source_id uuid;
 v_before jsonb;
 v_limits jsonb;
 v_pdf int;
 v_zip int;
 v_expand int;
 v_xml int;
 v_rows int;
BEGIN
 IF session_user <> 'radar_dou_limits_runtime' THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
 END IF;
 IF p_actor IS NULL OR p_nonce IS NULL OR p_issued_at IS NULL
    OR p_mac IS NULL OR p_mac !~ '^[a-f0-9]{64}$'
    OR pg_catalog.abs(pg_catalog.date_part('epoch',pg_catalog.clock_timestamp())
      -p_issued_at)>90 THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='dou_limits_signature_invalid';
 END IF;
 IF p_limits IS NULL OR pg_catalog.jsonb_typeof(p_limits)<>'object'
    OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_limits))<>4
    OR NOT (p_limits ?& ARRAY['pdfMiB','zipMiB','expandedZipMiB','xmlEntryMiB'])
    OR (SELECT bool_and(pg_catalog.jsonb_typeof(value)='number'
          AND value::text ~ '^[0-9]{1,3}$')
          FROM pg_catalog.jsonb_each(p_limits)) IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_dou_limits';
 END IF;
 v_pdf:=(p_limits->>'pdfMiB')::int;
 v_zip:=(p_limits->>'zipMiB')::int;
 v_expand:=(p_limits->>'expandedZipMiB')::int;
 v_xml:=(p_limits->>'xmlEntryMiB')::int;
 IF v_pdf NOT BETWEEN 1 AND 20 OR v_zip NOT BETWEEN 1 AND 64
    OR v_expand NOT BETWEEN 1 AND 128 OR v_xml NOT BETWEEN 1 AND 8
    OR v_expand<v_zip THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_dou_limits';
 END IF;
 v_limits:=pg_catalog.jsonb_build_object(
   'pdfMiB',v_pdf,'zipMiB',v_zip,'expandedZipMiB',v_expand,'xmlEntryMiB',v_xml
 );
 v_message:='OPS-DL-01/v1|'||p_actor::text||'|'||p_issued_at::text||
   '|'||p_nonce::text||'|'||v_pdf::text||'|'||v_zip::text||
   '|'||v_expand::text||'|'||v_xml::text;
 SELECT key_bytes INTO v_key FROM public.ops_dou_limits_signing_keys WHERE key_id='v1';
 IF v_key IS NULL OR pg_catalog.encode(public.hmac(pg_catalog.convert_to(v_message,'UTF8'),
     v_key,'sha256'),'hex')<>p_mac THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='dou_limits_signature_invalid';
 END IF;

 -- Role administration uses this same lock; a concurrent revocation cannot
 -- interleave between permission evaluation and this COMMIT.
 PERFORM pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended('platform-admin-role',0));
 SELECT u.id INTO v_actor FROM public.app_users u
 JOIN public.platform_user_roles r ON r.user_id=u.id
 WHERE u.id=p_actor AND u.status='ACTIVE' AND r.role='PLATFORM_ADMIN'
   AND r.revoked_at IS NULL LIMIT 1;
 IF v_actor IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
 END IF;
 -- No nonce can be reused even with a genuine signature.
 INSERT INTO public.ops_dou_limits_used_nonces(nonce,actor_id,issued_at)
 VALUES(p_nonce,p_actor,p_issued_at);
 PERFORM pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended('platform-dou-download-limits',0));
 SELECT s.id,s.connector_config->'douDownloadLimits' INTO v_source_id,v_before
 FROM public.sources s WHERE s.code='dou' AND s.connector_key='dou' FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='dou_source_not_found';
 END IF;
 IF v_before IS NOT DISTINCT FROM v_limits THEN RETURN v_limits; END IF;
 UPDATE public.sources s SET connector_config=s.connector_config||
   pg_catalog.jsonb_build_object('douDownloadLimits',v_limits),
   updated_at=pg_catalog.clock_timestamp()
 WHERE s.id=v_source_id;
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 IF v_rows<>1 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='dou_source_update_not_unique';
 END IF;
 INSERT INTO public.audit_log(tenant_id,actor_type,actor_id,action,
  entity_type,entity_id,before_data,after_data,correlation_id)
 VALUES(NULL,'ADMIN',p_actor::text,'DOU_DOWNLOAD_LIMITS_UPDATED',
  'sources.connector_config',v_source_id::text,
  public.audit_project('DOU_DOWNLOAD_LIMITS_UPDATED','sources.connector_config',v_before),
  public.audit_project('DOU_DOWNLOAD_LIMITS_UPDATED','sources.connector_config',v_limits),
  pg_catalog.gen_random_uuid());
 RETURN v_limits;
END
$gate$;
REVOKE ALL ON FUNCTION public.platform_admin_set_dou_limits(uuid,jsonb,bigint,uuid,text)
 FROM PUBLIC,radar_app,radar_worker;
GRANT EXECUTE ON FUNCTION public.platform_admin_set_dou_limits(uuid,jsonb,bigint,uuid,text)
 TO radar_dou_limits_runtime;

-- Capability flag: no signing secret ever reaches the general app runtime.
CREATE FUNCTION public.platform_dou_limits_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $ready$
 SELECT EXISTS(
  SELECT 1 FROM public.ops_dou_limits_signing_keys WHERE key_id='v1'
 )
$ready$;
REVOKE ALL ON FUNCTION public.platform_dou_limits_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_dou_limits_ready() TO radar_app;
