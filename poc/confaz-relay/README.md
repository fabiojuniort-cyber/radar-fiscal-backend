# CONFAZ Brazil-region egress relay POC

This directory contains a narrow proof-of-concept relay for validating a Brazil-region egress path to the official CONFAZ website.

The relay is intentionally **not** a generic proxy. It can only fetch the official origin:

`https://www.confaz.fazenda.gov.br`

and only the root path or paths under `/legislacao/`.

## Responsibilities

The relay only performs outbound HTTP(S) transport.

It does not contain:

- tax parsing;
- normalization;
- deduplication;
- versioning;
- collection scheduling/retries;
- PostgreSQL access;
- tenant data;
- publication persistence.

Those responsibilities remain in the Railway Worker.

## Security controls

- `GET /health` is the only unauthenticated endpoint.
- `GET /fetch?path=...` requires a Bearer token.
- Absolute/external URLs are rejected.
- Paths outside the CONFAZ root and `/legislacao/` are rejected.
- Upstream responses are streamed; the relay does not interpret tax content.
- Operational logs include path/status/timing only and do not log the bearer token.
- The relay has no database credentials.

## Required secret

Configure on the relay platform:

`RELAY_BEARER_TOKEN`

Use a long random secret and never commit it.

Optional:

`RELAY_UPSTREAM_TIMEOUT_MS` (default 20000)

## Local verification

From this directory:

```bash
npm test
docker build -t radar-fiscal-confaz-relay-poc .
```

## Fly.io POC

The target region is `gru` (São Paulo).

1. Copy `fly.toml.example` to `fly.toml`.
2. Replace the app name with the created Fly application name.
3. Set `RELAY_BEARER_TOKEN` as a Fly secret.
4. Deploy in `gru`.
5. Confirm `/health` returns HTTP 200.
6. Test one CONFAZ index path.
7. Only after that, point the Railway Worker source-specific relay adapter at this relay.

The POC should use no volume and no database. Auto-stop may remain enabled.

## Acceptance

The relay path is technically useful only if:

- Fly GRU can reach `www.confaz.fazenda.gov.br:443`;
- a real official index returns valid HTTP;
- a real Railway collection run can persist at least one official publication;
- a second run proves deduplication;
- no tax-processing responsibility moves out of Railway.

Successful POC evidence is still subject to Gerente Geral approval before the proposed ADR can become accepted.
