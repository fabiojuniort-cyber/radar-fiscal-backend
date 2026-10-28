import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { z } from 'zod';

import { AdminError, mapDbError, withAdminTx } from '../../modules/anatomy/admin/rules-admin.service.js';
import {
  analyze, auditConfigAttempt, ConfigValidationError, listConfigAudit, listVersions, readActive, readVersion, restore, rulesView, sampleSummaries, save, suggestions,
} from '../../modules/anatomy/config/config.service.js';
import { FIELD_CATALOG, SOURCE_PT } from '../../modules/anatomy/config/rules.js';
import { NATURE_PT } from '../../modules/anatomy/config/view.js';
import { PROFILE_SOURCES } from '../../modules/anatomy/profile.js';
import type { SimulationExecutor } from '../../modules/anatomy/simulation-executor.js';
import { isPlatformAdmin } from '../../modules/auth/platform-role.js';

/**
 * ANAT-CONFIG-01: API of the accessible anatomy configuration. Every route requires an authenticated PLATFORM_ADMIN;
 * the identity comes from authentication only. Messages for invalid input are specific and in Portuguese; they never
 * echo SQL or internal errors.
 */
const PREFIX = '/api/v1/admin/anatomy-config';
const uuid = z.string().uuid();
const NATURES = ['operative', 'historical', 'editorial_note', 'amendment', 'structure', 'ambiguous'] as const;
const scope = z.discriminatedUnion('level', [
  z.strictObject({ level: z.literal('default') }),
  z.strictObject({ level: z.literal('source'), source: z.enum(PROFILE_SOURCES) }),
  z.strictObject({ level: z.literal('family'), source: z.enum(PROFILE_SOURCES), family: z.string().min(1).max(64) }),
]);
const change = z.strictObject({ scope, path: z.string().min(3).max(64), action: z.enum(['add', 'remove']), literal: z.string().max(200) });
const correction = z.strictObject({ sampleId: z.string().min(1).max(64), partKey: z.string().regex(/^[a-f0-9]{16}$/u), expected: z.enum(NATURES), note: z.string().max(500).optional() });
const changes = z.array(change).max(100).default([]);
const corrections = z.array(correction).max(500);
const analysisBody = z.strictObject({ sampleIds: z.array(z.string().min(1).max(64)).max(50).optional(), changes, corrections: corrections.optional() });
const saveBody = z.strictObject({ basedOnVersion: z.number().int().min(0), changes, corrections, note: z.string().max(2000).optional() });
const restoreBody = z.strictObject({ basedOnVersion: z.number().int().min(0), versionId: uuid, note: z.string().max(2000).optional() });
const suggestBody = z.strictObject({ sampleId: z.string().min(1).max(64), text: z.string().min(1).max(4000), wanted: z.enum(NATURES) });

const MESSAGES: Record<string, string> = {
  STALE_VERSION: 'Outra pessoa salvou uma configuração depois que você começou. Recarregue para ver a versão atual; suas alterações continuam na tela para refazer.',
  VERSION_NOT_FOUND: 'Essa versão não existe mais.', SAMPLE_NOT_FOUND: 'Exemplo de ato não encontrado.', SIMULATION_UNAVAILABLE: 'O teste está indisponível no momento. Tente de novo em instantes; nada foi alterado.',
  ABORTED: 'O teste foi interrompido.', invalid_request: 'Pedido incompleto ou inválido. Revise os campos e tente de novo.', platform_admin_required: 'Somente administradores da plataforma podem usar esta tela.',
  invalid_configuration: 'A configuração não é válida.', INVALID_PROFILE: 'A configuração não é válida.', INVALID_CORRECTION: 'Uma das correções de trecho é inválida.',
  HASH_MISMATCH: 'A configuração mudou durante o envio. Tente de novo.', audit_unavailable: 'A auditoria não pôde ser registrada; nada foi salvo.', internal_error: 'Erro interno; nada foi alterado.',
};

export interface AnatomyConfigDeps { pool: Pool; executor: SimulationExecutor | null }
export async function anatomyConfigRoutes(app: FastifyInstance, deps: AnatomyConfigDeps): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const requirePlatformAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!request.auth || !(await isPlatformAdmin(app.db, request.auth.userId))) await reply.status(403).send({ error: 'platform_admin_required', message: MESSAGES.platform_admin_required });
  };
  app.setErrorHandler(async (error: { validation?: unknown; statusCode?: number }, _request, reply) => {
    if (error.validation) return reply.status(422).send({ error: 'invalid_request', message: MESSAGES.invalid_request });
    if (error.statusCode === 413) return reply.status(413).send({ error: 'payload_too_large', message: 'Pedido grande demais.' });
    return reply.status(500).send({ error: 'internal_error', message: MESSAGES.internal_error });
  });
  const correlation = (request: FastifyRequest) => { const h = request.headers['x-correlation-id']; return typeof h === 'string' && uuid.safeParse(h).success ? h : randomUUID(); };
  async function handle<T>(request: FastifyRequest, reply: FastifyReply, op: 'SAVE' | 'RESTORE' | null, target: string | null, fn: (corr: string, user: string) => Promise<T>, okStatus = 200) {
    const corr = correlation(request); const user = request.auth!.userId;
    reply.header('x-correlation-id', corr);
    try { return reply.status(okStatus).send(await fn(corr, user)); } catch (raw) {
      if (raw instanceof ConfigValidationError) return reply.status(422).send({ error: 'invalid_configuration', message: MESSAGES.invalid_configuration, issues: raw.issues, correlationId: corr });
      const error = raw instanceof AdminError ? raw : mapDbError(raw, target);
      if (op) await auditConfigAttempt(deps.pool, user, op, error.code, target, corr);
      if (error.status >= 500) request.log.warn({ code: error.code, correlationId: corr }, 'anatomy config failure');
      return reply.status(error.status).send({ error: error.code, message: MESSAGES[error.code] ?? MESSAGES.internal_error, correlationId: corr });
    }
  }
  const abortOn = (reply: FastifyReply) => { const ac = new AbortController(); reply.raw.once('close', () => { if (!reply.raw.writableFinished) ac.abort(); }); return ac.signal; };
  const guard = { preHandler: requirePlatformAdmin };

  typed.get(PREFIX, guard, (req, rep) => handle(req, rep, null, null, (_c, user) => withAdminTx(deps.pool, user, async (c) => {
    const active = await readActive(c);
    return { current: { ...active, profiles: undefined, rules: rulesView(active.profiles) }, catalog: FIELD_CATALOG, samples: sampleSummaries(),
      natures: NATURE_PT, sources: SOURCE_PT };
  })));
  typed.get(`${PREFIX}/versions`, guard, (req, rep) => handle(req, rep, null, null, (_c, user) => withAdminTx(deps.pool, user, listVersions)));
  typed.get(`${PREFIX}/versions/:id`, { ...guard, schema: { params: z.strictObject({ id: uuid }) } }, (req, rep) =>
    handle(req, rep, null, req.params.id, (_c, user) => withAdminTx(deps.pool, user, (c) => readVersion(c, req.params.id))));
  typed.post(`${PREFIX}/analysis`, { ...guard, schema: { body: analysisBody } }, (req, rep) =>
    handle(req, rep, null, null, (_c, user) => analyze(deps.pool, deps.executor, user, req.body, abortOn(rep))));
  typed.post(`${PREFIX}/suggestions`, { ...guard, schema: { body: suggestBody } }, (req, rep) => handle(req, rep, null, null, async () => suggestions(req.body)));
  typed.post(`${PREFIX}/save`, { ...guard, schema: { body: saveBody } }, (req, rep) =>
    handle(req, rep, 'SAVE', null, (corr, user) => save(deps.pool, user, req.body, corr), 201));
  typed.post(`${PREFIX}/restore`, { ...guard, schema: { body: restoreBody } }, (req, rep) =>
    handle(req, rep, 'RESTORE', req.body.versionId, (corr, user) => restore(deps.pool, user, req.body, corr), 201));
  typed.get(`${PREFIX}/audit`, guard, (req, rep) => handle(req, rep, null, null, (_c, user) => withAdminTx(deps.pool, user, listConfigAudit)));
}
