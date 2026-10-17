import { z } from 'zod';
import { canonicalJson, entitySchema, partSchema, sha256, spanSchema } from './contract.js';

/**
 * Structural gold for corpus measurement. A gold file is an independent human annotation over a frozen
 * canonical text; it is never derived from engine output and never records legal status or approval.
 */
export const ANATOMY_GOLD_VERSION = 'ANAT-GOLD/1.0.0' as const;

const id = z.string().min(1).max(200);
const goldPartSchema = z.strictObject({
  id, parentId: id.nullable(), order: z.number().int().nonnegative(), type: partSchema.shape.type, span: spanSchema,
  context: partSchema.shape.context, contextReason: id,
  table: z.strictObject({ row: z.number().int().nonnegative(), column: z.number().int().nonnegative(), rowSpan: z.number().int().positive(),
    columnSpan: z.number().int().positive(), geometry: z.enum(['original', 'uniquely_reconstructed', 'unknown']), headerDomain: id.nullable() }).nullable(),
});
const goldEntitySchema = z.strictObject({ id, partId: id, span: spanSchema, literal: z.string().min(1), domain: entitySchema.shape.domain, note: z.string().max(2000) });
const goldRelationSchema = z.strictObject({ id, kind: z.enum(['range', 'exception']), operatorSpan: spanSchema.nullable(),
  memberEntityIds: z.array(id), targetEntityIds: z.array(id), scopeSpan: spanSchema.nullable(), condition: z.string().max(2000).nullable() });
const goldGapSchema = z.strictObject({ kind: z.enum(['unidentified', 'missing_attachment', 'unreadable_image', 'uncertain_geometry', 'other']),
  span: spanSchema.nullable(), resource: z.string().nullable(), note: z.string().max(2000) });

export const anatomyGoldShapeSchema = z.strictObject({
  goldVersion: z.literal(ANATOMY_GOLD_VERSION),
  id: z.string().regex(/^\d{2}$/),
  partition: z.literal('development'),
  preparation: id,
  canonicalTextSha256: z.string().regex(/^[0-9a-f]{64}$/),
  canonicalTextUtf16Length: z.number().int().nonnegative(),
  status: z.enum(['not_started', 'in_progress', 'prepared', 'reviewed']),
  annotator: id.nullable(),
  annotatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  parts: z.array(goldPartSchema), entities: z.array(goldEntitySchema), relations: z.array(goldRelationSchema), gaps: z.array(goldGapSchema),
  review: z.strictObject({ reviewer: id.nullable(), status: z.enum(['not_requested', 'requested', 'changes_requested', 'approved']),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    /** Hash of the exact annotation content the reviewer approved; any later change invalidates it. */
    approvedContentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), notes: z.string().max(20000) }),
});
export type AnatomyGold = z.infer<typeof anatomyGoldShapeSchema>;

/** SHA-256 of the annotation content (everything except status and review), as bound by an approval. */
export function goldContentSha256(gold: AnatomyGold): string {
  const { status: _status, review: _review, ...content } = gold;
  return sha256(canonicalJson(content));
}

/** Validate shape and structural invariants; with `canonicalText`, also literals and the text hash. */
export function validateAnatomyGold(value: unknown, canonicalText?: string): AnatomyGold {
  const gold = anatomyGoldShapeSchema.parse(value);
  const fail = (message: string): never => { throw new Error(`gold ${gold.id}: ${message}`); };
  const n = gold.canonicalTextUtf16Length;
  if (canonicalText !== undefined) {
    if (canonicalText.length !== n || sha256(canonicalText) !== gold.canonicalTextSha256) fail('canonical text does not match the frozen hash/length');
  }
  const inside = (s: { start: number; end: number }, label: string): void => { if (s.start > s.end || s.end > n) fail(`${label} span out of bounds`); };
  const surrogate = (i: number): boolean => canonicalText !== undefined && i > 0 && i < n
    && /[\uD800-\uDBFF]/.test(canonicalText[i - 1]!) && /[\uDC00-\uDFFF]/.test(canonicalText[i]!);
  const parts = new Map<string, AnatomyGold['parts'][number]>(); const roots = gold.parts.filter((p) => p.parentId === null);
  if (gold.status !== 'not_started') {
    if (roots.length !== 1 || roots[0]!.type !== 'document' || roots[0]!.span.start !== 0 || roots[0]!.span.end !== n) fail('exactly one document root covering the full text is required');
  }
  for (const p of gold.parts) {
    if (parts.has(p.id)) fail(`duplicate part ${p.id}`);
    if (p.parentId !== null && !parts.has(p.parentId)) fail(`part ${p.id} must follow its parent`);
    inside(p.span, p.id);
    if (surrogate(p.span.start) || surrogate(p.span.end)) fail(`part ${p.id} splits a surrogate pair`);
    const parent = p.parentId === null ? null : parts.get(p.parentId)!;
    if (parent && (p.span.start < parent.span.start || p.span.end > parent.span.end)) fail(`part ${p.id} outside its parent`);
    if (p.type === 'cell' && !p.table) fail(`cell ${p.id} requires table geometry`);
    parts.set(p.id, p);
  }
  const siblings = new Map<string | null, AnatomyGold['parts']>();
  for (const p of gold.parts) siblings.set(p.parentId, [...(siblings.get(p.parentId) ?? []), p]);
  for (const list of siblings.values()) {
    const sorted = [...list].sort((a, b) => a.order - b.order);
    sorted.forEach((p, i) => {
      if (p.order !== i) fail(`sibling order of ${p.id} is not contiguous from zero`);
      const prev = sorted[i - 1]; if (prev && p.span.start < prev.span.end) fail(`siblings ${prev.id} and ${p.id} overlap or are out of order`);
    });
  }
  const entities = new Set<string>();
  for (const e of gold.entities) {
    if (entities.has(e.id)) fail(`duplicate entity ${e.id}`); entities.add(e.id);
    inside(e.span, e.id);
    const part = parts.get(e.partId); if (!part) fail(`entity ${e.id} references unknown part`);
    if (e.span.start < part!.span.start || e.span.end > part!.span.end) fail(`entity ${e.id} outside its part`);
    if (canonicalText !== undefined && canonicalText.slice(e.span.start, e.span.end) !== e.literal) fail(`entity ${e.id} literal differs from text`);
  }
  for (const r of gold.relations) {
    for (const ref of [...r.memberEntityIds, ...r.targetEntityIds]) if (!entities.has(ref)) fail(`relation ${r.id} references unknown entity ${ref}`);
    if (r.operatorSpan) inside(r.operatorSpan, r.id); if (r.scopeSpan) inside(r.scopeSpan, r.id);
  }
  for (const g of gold.gaps) if (g.span) inside(g.span, 'gap');
  if (gold.review.status === 'approved' && gold.review.approvedContentSha256 !== goldContentSha256(gold)) {
    fail('approval does not match the current annotation content; the changed annotation needs a new review');
  }
  if (gold.review.status !== 'approved' && gold.review.approvedContentSha256 !== null) fail('approvedContentSha256 is only set by an approved review');
  if (gold.status === 'reviewed' && (gold.review.status !== 'approved' || !gold.review.reviewer || gold.review.reviewer === gold.annotator)) {
    fail('reviewed gold requires an approved review by someone other than the annotator');
  }
  return gold;
}
