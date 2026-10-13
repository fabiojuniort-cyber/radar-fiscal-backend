import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { kyselyRunner } from '../../modules/taxonomy/curation/curation.read.js';
import { loadPublicationTaxonomy } from '../../modules/taxonomy/curation/curation.tags.js';

const publicationParams = z.object({ publicationId: z.string().uuid() });

export async function publicationTaxonomyRoutes(
  app: FastifyInstance,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // TAX-11: tags at the end of a legislation page, grouped by section.
  // Rejected automatic tags are hidden; curator-added tags are included.
  typed.get(
    '/api/v1/publications/:publicationId/taxonomy',
    {
      preHandler: app.authenticate,
      schema: { params: publicationParams },
    },
    async (request, reply) => {
      if (!request.auth) return reply.status(401).send({ error: 'unauthorized' });
      const view = await loadPublicationTaxonomy(
        kyselyRunner(app.db),
        request.params.publicationId,
      );
      if (view.status === 'NOT_FOUND') {
        return reply.status(404).send({ error: 'publication_not_found' });
      }
      return reply.send(view);
    },
  );
}
