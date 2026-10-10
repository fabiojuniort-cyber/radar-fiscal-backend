import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

/** STATIC/DESIGN-ONLY checks: not PostgreSQL, HTTPS, or evidence of publication. */
const sql = readFileSync(new URL('../docs/taxonomy/TAX13_R9_DOU_R4_FULL_DDL_REVIEW.sql', import.meta.url), 'utf8');
const rfc = readFileSync(new URL('../docs/taxonomy/TAX13_R9_DOU_CANONICAL_CONTRACT_R4.md', import.meta.url), 'utf8');

test('R4 design: XML matter and N act anchors are independent of PDF correlation', () => {
  assert.match(sql, /CREATE TABLE public\.tax13_dou_xml_matters\s*\(/);
  assert.match(sql, /CREATE TABLE public\.tax13_dou_xml_act_anchors\s*\(/);
  assert.match(sql, /CREATE TABLE public\.tax13_dou_xml_temporal_review_events\s*\(/);
  assert.match(sql, /xml_act_anchor_id uuid NOT NULL REFERENCES public\.tax13_dou_xml_act_anchors/);
  assert.match(sql, /optional_documentary_correlation_id uuid,/);
  assert.doesNotMatch(sql, /correlation_id uuid NOT NULL REFERENCES public\.tax13_dou_act_correlations/);
  assert.match(sql, /FOREIGN KEY\(optional_documentary_correlation_id,xml_act_anchor_id\)/);
});

test('R4 design: capture bounds are purpose-specific and keep XML ZIP capacity', () => {
  assert.match(sql, /purpose='PDF' AND byte_count BETWEEN 1 AND 20971520/);
  assert.match(sql, /purpose='INLABS_ZIP' AND byte_count BETWEEN 1 AND 67108864/);
  assert.match(sql, /purpose='OFFICIAL_INDEX' AND byte_count BETWEEN 1 AND 2097152/);
  assert.match(sql, /zip_total_entries integer NOT NULL CHECK\(zip_total_entries BETWEEN 1 AND 5000\)/);
  assert.match(sql, /zip_uncompressed_bytes bigint NOT NULL CHECK\(zip_uncompressed_bytes BETWEEN 0 AND 134217728\)/);
  assert.match(sql, /jsonb_array_length\(matter_parts\) BETWEEN 1 AND 48/);
});

test('R4 design: N act correlations per dispatch and no cross-matter typed references', () => {
  assert.match(sql, /verification_event_id uuid NOT NULL,/);
  assert.doesNotMatch(sql, /verification_event_id uuid NOT NULL UNIQUE/);
  assert.match(sql, /UNIQUE\(verification_event_id,xml_act_anchor_id\)/);
  assert.match(sql, /FOREIGN KEY\(xml_act_anchor_id,xml_matter_id\)/);
  assert.match(sql, /FOREIGN KEY\(xml_act_anchor_id,child_act_version_id\)/);
  assert.match(sql, /FOREIGN KEY\(xml_matter_id,parent_dispatch_version_id\)/);
  assert.match(sql, /FOREIGN KEY\(job_id,xml_matter_id\)/);
});

test('R4 design: official edition suffix requires proof, and legal CURRENT remains separate', () => {
  assert.match(rfc, /80-A/);
  assert.match(rfc, /80-B/);
  assert.match(rfc, /INDEX_PENDING/);
  assert.match(rfc, /PDF.*seletiv/i);
  assert.match(rfc, /CURRENT/);
  assert.match(rfc, /DO NOT EXECUTE|DO NOT APPLY|NÃO É MIGRATION/i);
});

test('R4 design: never mistake a static contract for SQL or official-network tests', () => {
  assert.match(sql, /NOT migration 049\+/);
  assert.match(sql, /NOT VERIFIED/);
  assert.match(rfc, /não.*compilad|não foi compilado/i);
  assert.equal((sql.match(/CREATE TABLE public\./g) ?? []).length, 11);
});
