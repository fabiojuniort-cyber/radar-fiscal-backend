import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  AdminError, auditAttempt, candidateDetail, compare, confirm, freeze, listActivations, listAudit, listCandidates, listDrafts,
  mapDbError, preview, readDraft, review, saveDraft, simulate, withAdminTx, type Operation,
} from '../../modules/anatomy/admin/rules-admin.service.js';
import type { SimulationExecutor } from '../../modules/anatomy/simulation-executor.js';
import { isPlatformAdmin } from '../../modules/auth/platform-role.js';

/**
 * ANAT-ADMIN-01 P3-D (issue #116): administrative API for anatomy rules (P3 §3).
 * NOT registered in `buildApp()`: the feature stays unavailable to real users until a reviewed integration package
 * wires it (with its own pool and executor). Every route requires an authenticated PLATFORM_ADMIN; the identity is
 * taken from authentication only, never from the body.
 */
export interface AnatomyRulesAdminDeps { pool: Pool; executor: SimulationExecutor | null }
const PREFIX = '/api/v1/admin/anatomy-rules';
const uuid = z.string().uuid();
const idParams = z.strictObject({ id: uuid });
const examples = z.array(z.record(z.string(), z.unknown())).min(1).max(20);
const profiles = z.array(z.unknown()).min(1).max(64);
const draftBody = z.strictObject({ profiles, examples });
const draftUpdate = z.strictObject({ revision: z.number().int().min(1), profiles, examples });
const freezeBody = z.strictObject({ revision: z.number().int().min(1) });
const scope = z.string().regex(/^[a-z0-9:_-]{1,64}$/u);
const compareBody = z.strictObject({ scope: scope.default('global'), baselineRuleSetId: z.string().min(1).max(64).nullable().default(null) });
const reviewBody = z.strictObject({
  simulationId: uuid, outcome: z.enum(['approved', 'rejected']), rationale: z.string().min(10).max(4000),
  comparisonIds: z.array(uuid).max(20).default([]),
  decisions: z.array(z.strictObject({ comparisonId: uuid, differenceId: z.string().min(1).max(64), decision: z.enum(['expected', 'regression', 'not_evaluated']),
    note: z.string().max(2000).optional() })).max(2000).default([]),
});
const previewBody = z.strictObject({ action: z.enum(['activate', 'rollback']), candidateId: uuid, reviewId: uuid, scope: scope.default('global') });
const confirmBody = z.strictObject({ token: z.string().min(20).max(128), intentHash: z.string().regex(/^[a-f0-9]{64}$/u), justification: z.string().min(10).max(4000) });

export async function anatomyRulesAdminRoutes(app: FastifyInstance, deps: AnatomyRulesAdminDeps): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const requirePlatformAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!request.auth || !(await isPlatformAdmin(app.db, request.auth.userId))) await reply.status(403).send({ error: 'platform_admin_required' });
  };
  // Validation errors never echo the input.
  app.setErrorHandler(async (error: { validation?: unknown; statusCode?: number }, _request, reply) => {
    if (error.validation) return reply.status(422).send({ error: 'invalid_request' });
    if (error.statusCode === 413) return reply.status(413).send({ error: 'payload_too_large' });
    return reply.status(500).send({ error: 'internal_error' });
  });
  const correlation = (request: FastifyRequest): string => {
    const h = request.headers['x-correlation-id'];
    return typeof h === 'string' && uuid.safeParse(h).success ? h : randomUUID();
  };
  /** Runs a handler; failures after authorisation and validation are audited (separate transaction) when coded. */
  async function handle<T>(request: FastifyRequest, reply: FastifyReply, op: Operation | null, target: string | null, fn: (corr: string, user: string) => Promise<T>, okStatus = 200) {
    const corr = correlation(request); const user = request.auth!.userId;
    reply.header('x-correlation-id', corr);
    try { return reply.status(okStatus).send(await fn(corr, user)); } catch (raw) {
      const error = mapDbError(raw, target);
      if (op && error.attempt) await auditAttempt(deps.pool, user, op, error, corr);
      if (error.status >= 500) request.log.warn({ code: error.code, correlationId: corr }, 'anatomy rules admin failure');
      return reply.status(error.status).send({ error: error.code, correlationId: corr });
    }
  }
  /** Aborts when the client goes away before the response is finished (the request stream's own 'close' is not a signal). */
  const abortOn = (reply: FastifyReply): AbortSignal => {
    const ac = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
    return ac.signal;
  };
  const read = <T>(request: FastifyRequest, reply: FastifyReply, fn: Parameters<typeof withAdminTx<T>>[2]) =>
    handle(request, reply, null, null, (_c, user) => withAdminTx(deps.pool, user, fn));

  const guard = { preHandler: requirePlatformAdmin };
  typed.get(`${PREFIX}/drafts`, guard, (req, rep) => read(req, rep, (c) => listDrafts(c)));
  typed.get(`${PREFIX}/drafts/:id`, { ...guard, schema: { params: idParams } }, (req, rep) => read(req, rep, (c) => readDraft(c, req.params.id)));
  typed.post(`${PREFIX}/drafts`, { ...guard, bodyLimit: 8 * 1024 * 1024, schema: { body: draftBody } }, (req, rep) =>
    handle(req, rep, 'DRAFT_SAVE', null, (corr, user) => withAdminTx(deps.pool, user, (c) => saveDraft(c, { id: null, revision: null, ...req.body }, corr)), 201));
  typed.put(`${PREFIX}/drafts/:id`, { ...guard, bodyLimit: 8 * 1024 * 1024, schema: { params: idParams, body: draftUpdate } }, (req, rep) =>
    handle(req, rep, 'DRAFT_SAVE', req.params.id, (corr, user) => withAdminTx(deps.pool, user, (c) => saveDraft(c, { id: req.params.id, ...req.body }, corr))));
  typed.post(`${PREFIX}/drafts/:id/freeze`, { ...guard, schema: { params: idParams, body: freezeBody } }, (req, rep) =>
    handle(req, rep, 'FREEZE', req.params.id, (corr, user) => withAdminTx(deps.pool, user, (c) => freeze(c, req.params.id, req.body.revision, corr))));
  typed.get(`${PREFIX}/candidates`, guard, (req, rep) => read(req, rep, (c) => listCandidates(c)));
  typed.get(`${PREFIX}/candidates/:id`, { ...guard, schema: { params: idParams } }, (req, rep) => read(req, rep, (c) => candidateDetail(c, req.params.id)));
  typed.post(`${PREFIX}/candidates/:id/simulate`, { ...guard, schema: { params: idParams } }, (req, rep) =>
    handle(req, rep, 'SIMULATE', req.params.id, (corr, user) => simulate(deps.pool, deps.executor, user, req.params.id, corr, abortOn(rep))));
  typed.post(`${PREFIX}/candidates/:id/compare`, { ...guard, schema: { params: idParams, body: compareBody } }, (req, rep) =>
    handle(req, rep, 'COMPARE', req.params.id, (corr, user) => compare(deps.pool, deps.executor, user, req.params.id, req.body, corr, abortOn(rep))));
  typed.post(`${PREFIX}/candidates/:id/reviews`, { ...guard, schema: { params: idParams, body: reviewBody } }, (req, rep) =>
    handle(req, rep, 'REVIEW', req.params.id, (corr, user) => withAdminTx(deps.pool, user, async (c) => ({ reviewId: await review(c, req.params.id, req.body, corr) })), 201));
  typed.post(`${PREFIX}/activation/preview`, { ...guard, schema: { body: previewBody } }, (req, rep) =>
    handle(req, rep, 'PREVIEW', req.body.candidateId, (corr, user) => withAdminTx(deps.pool, user, (c) => preview(c, req.body, corr)), 201));
  typed.post(`${PREFIX}/activation/confirm`, { ...guard, schema: { body: confirmBody } }, (req, rep) =>
    handle(req, rep, 'CONFIRM', null, (corr, user) => confirm(deps.pool, user, req.body, corr)));
  typed.get(`${PREFIX}/activations`, guard, (req, rep) => read(req, rep, (c) => listActivations(c)));
  typed.get(`${PREFIX}/audit`, guard, (req, rep) => read(req, rep, (c) => listAudit(c)));
}
export { AdminError };
