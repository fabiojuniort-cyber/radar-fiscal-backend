# PostgreSQL 18 isolated recovery / privilege harness

Status on preparation: **NOT_RUN**. Only shell syntax / static inspection is
authorized during preparation. This harness does not supply production evidence.

Future explicit execution, on a machine with the official `postgres:18-bookworm` image
already present and a local Docker daemon:

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin bash ./test-pg18-isolated.sh --run-isolated-fixture
```

No image pull is performed. Docker is pinned to `/var/run/docker.sock`; the
container has `--network none`, no bind mounts, no published ports, no PostgreSQL
TCP listener, and host authentication rejected. All SQL uses its local Unix
socket and explicitly named `fixture_*` databases. Caller database and Docker
connection/configuration environment variables are rejected. A fixture identity
and server major version are checked. Cleanup removes only the labeled container
whose exact ID was returned by this run, together with its anonymous ephemeral
volumes. Fixture diagnostics remain in a unique
`/tmp/dou-clean-02-pg18.*` directory.

The harness runs the **actual** runner `suppress.sql`, `restore.sql`,
`recovery-state.sql`, and extracted preflight `privileges.sql` against a minimal
contract fixture. It does not substitute a simplified recovery or privilege
query. It covers:

- Nominal SUPPRESS, recovery snapshot, and optimistic RESTORE.
- A SUPPRESS transaction held before COMMIT, recovery observed waiting on a
  PostgreSQL lock, then a fresh snapshot observing the committed suppression.
- Lock timeout: nonzero exit, no stale JSON emitted.
- A safe privilege baseline and actual `SET SESSION AUTHORIZATION` / `SET ROLE`
  execution through a NOINHERIT runtime membership, for both transition and
  material-change functions; the actual privilege preflight must reject each.
- PUBLIC EXECUTE on either function; runtime DML, PUBLIC UPDATE, PUBLIC column
  DML, and reachable ownership on all three scope tables; reachable ownership
  of both governed functions. Reachable database/public-schema owners are rejected
  too. Every negative case starts from a cloned baseline.
- NOINHERIT / SET-able helper table and column UPDATE on each scope table;
  SET-able helper SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, and REPLICATION
  attributes. Cluster-global role attributes and memberships are reset after
  each case. There are 53 negative privilege cases in total.

The delayed case inserts `pg_sleep(5)` immediately before the actual SUPPRESS
script's COMMIT. That models an in-flight commit whose acknowledgment the caller
does not yet have. It is **not** a process crash, transport fault, PostgreSQL crash
recovery, authenticated API, complete production migration, or adversarial worker
integration test. The fixture transition reproduces only the minimal locking,
event, epoch, and optimistic-restore contract needed to exercise these SQL files.
Material restoration and narrow helper bodies are inert fixtures used only
for ACL tests. The fixture models the app's two public history columns and
the migration's predicate/epoch/imported-today/curator EXECUTE grants.
Negative cases also cover raw ledger SELECT, private history columns (direct
and SET-able), PUBLIC narrow helpers, wrong-family EXECUTE and missing grants.

Static-only command (does not start Docker or PostgreSQL):

```sh
bash ./test-pg18-isolated.sh --syntax-only
```
