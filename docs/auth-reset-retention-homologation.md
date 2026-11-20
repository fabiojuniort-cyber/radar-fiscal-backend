# AUTH-RESET retention in homologation

Issue #9. Fábio approves policy and future execution. Only an authorized operational session may run a sweep. No automatic scheduling or runtime grants.

Call the administrative function with request days, outbox days and token hours explicitly. Homologation uses (7, 7, 24). Omit the final argument for dry-run; the fourth argument caps outbox and tokens separately (1–5000). Request deletion reuses migration 085 with its separate fixed ceiling of 5000. Dry-run reports all eligible rows, not the number that one batch will delete. Actual runs use READ COMMITTED, a bounded statement timeout, and separate transactions per batch. Stop on error or lack of progress and reassess before retrying. Locked rows may be deferred.

The sweep deletes eligible outbox rows first. When deleting aged unusable tokens, it locks parent rows and rechecks that no outbox remains, so the FK cascade does not delete delivery work during retention. The existing account deletion cascade remains unchanged. Payloads are already cleared on terminal transitions by the reset routines and enforced by table checks.

Record only UTC timestamp, environment, authorization, version, and returned aggregate counts. The deferred counters describe the pre-sweep observation: tokens_deferred counts aged tokens blocked by outbox, tokens_waiting_active_outbox counts the pending/claimed subset, oldest_waiting_active_seconds tracks its age. Rising counts or age warrant investigation of delivery backlog and expired claims.

Production retention, backup expiry and restore handling, and Zoho message/log retention and deletion remain pending ratification. The 30-day value in R4 is a historical test parameter.
