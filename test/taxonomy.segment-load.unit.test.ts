import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseSegmentPackage } from '../src/modules/taxonomy/curation/curation.segment-package.js';

const raw = readFileSync('ops/taxonomy/loads/trifaros-cnae-2.3.json', 'utf8');
test('official workbook package preserves all codes, hierarchy and alias limits', () => {
  const data = parseSegmentPackage(raw);
  assert.equal(createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex'), 'c6d2b14bdd6e7f023ca56e6a67c3749434d357a68035b5bb4ae7f178da8b5298');
  assert.equal(data.rows.length, 1332);
  assert.equal(data.segments.length, 32);
  assert.equal(data.subsegments.length, 137);
  assert.equal(data.rows.reduce((sum, row) => sum + row.synonyms.length, 0), 17671);
  assert.equal(data.rows[0]!.cnae, '0111301');
  assert.equal(data.rows[0]!.description, 'Cultivo de arroz');
  assert.ok(data.rows.every(row => row.synonyms.length > 0 && row.synonyms.length <= 200));
});
test('rejects duplicate CNAE and mismatched hierarchy before any DB operation', () => {
  const duplicate = JSON.parse(raw);
  duplicate.rows.push(duplicate.rows[0]);
  assert.throws(() => parseSegmentPackage(JSON.stringify(duplicate)), /CNAE repetido/);
  const mismatch = JSON.parse(raw);
  mismatch.rows[0].segmentId = 'NOT_A_SEGMENT';
  assert.throws(() => parseSegmentPackage(JSON.stringify(mismatch)), /incompatíveis/);
});
