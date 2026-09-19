# Radar Fiscal Backend

Backend cloud service for Radar Fiscal.

## Stack

- Node.js
- TypeScript
- Fastify
- PostgreSQL
- Kysely
- Railway

## Database

SQL migrations in `/migrations` are the source of truth for the schema.

Useful commands:

```bash
npm run typecheck
npm run build
npm run db:migrate
npm run db:types
```

The production service exposes `GET /health` for application and database health checks.
