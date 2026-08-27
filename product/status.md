# Status

> The honest state of the Duraflow build. Updated 2026-08-27.

Every claim here maps to a file or directory in the repo. If you find a discrepancy, it's a bug - fix it in the same commit.

## TL;DR

Phase 1 (the engine) is shipped and now correct - durable execution, sagas, dead-letter queue, reaper, leader election, worker threads, backpressure are all built and tested. A saga-compensation defect that made rollback a no-op in the real runtime was found and fixed on 2026-07-04 (see "Recent fixes" below). Phase 2 (SDK ecosystem) is in progress: the Python SDK, the external-worker gRPC RPCs, and rate limiting are done; LangChain/CrewAI adapters, REST API, and CLI are not started. Phase 3 (dashboard, cost, human-in-loop) and Phase 4 (time-travel + hardening + launch) haven't started.

You can self-host the engine today, write a workflow against the TypeScript or Python SDK, and run it. You'd be an early adopter - no hosted cloud, no auth layer, no observability stack - but the core promise (durability + sagas) genuinely works end-to-end now.

## Recent fixes (2026-07-04)

- **Saga compensation now works end-to-end.** `compensation_fn` used to get dropped in the worker→executor IPC path (never persisted), and the compensation registry lived only in the worker thread while rollback ran in the main thread - so real-runtime rollback compensated zero steps while the isolation tests stayed green. Fixed by persisting `compensation_fn`, loading workflows in the main thread, and redesigning compensations to be pure functions of a step's saved output, declared on `workflow(name, handler, { compensations })`. There's now an integration test (`tests/integration/saga-execution.test.ts`) that drives a saga through the real worker path to prove it.
- **Reaper leader failover fixed.** Followers used to attempt election once at startup and never again, so a dead leader was never replaced. They now re-attempt election each tick and promote themselves once the lease frees.
- **Dead code removed** - `RequestCoalescer`, `TaskRepository.findPendingTasks`.
- **Postgres remapped to host port 5433** (host 5432 was taken by another Postgres) across compose, env, migration, and tests.

## Phase 1 - Core Engine [SHIPPED]

### Infrastructure
- Turborepo monorepo with npm workspaces (`apps/engine`, `packages/sdk`, `packages/proto`, `packages/python-sdk`, `packages/typescript-config`)
- Docker Compose for local dev (`postgres:16` on host 5433, `redis:7`, `qdrant/qdrant`)
- TypeScript 5.9 strict everywhere

### Data Layer
- Three tables - `agent_tasks`, `step_runs`, `dead_letter_queue` - with indexes; a `runtime` column routes node vs. external workers
- Schema in `apps/engine/src/db/init.sql`, applied on fresh volume and via manual `migrate.ts` (idempotent)
- Raw `pg@8.17` with parameterized SQL, no ORM
- `FOR UPDATE SKIP LOCKED` as the queue primitive

### Engine Services
- Poller with exponential backoff (100→200→400→500 ms cap) + backpressure (queue depth + event-loop lag)
- Heartbeat service (per-task interval)
- Reaper for stale-task recovery, with working leader failover
- Redis leader election with Lua check-and-renew (`SET NX EX` + atomic EXPIRE)
- Piscina worker thread pool (size = `max(2, cpuCores - 1)`) + MessageChannel IPC (30 s timeout)

### gRPC Surface (`@grpc/grpc-js` 1.9)
- `SubmitTask`, `GetTaskStatus`, `CancelTask` (with in-flight cancel + auto-rollback)
- `GetStep` / `CompleteStep` / `FailStep` (SDK step recovery) - now wired
- `DequeueTask` / `Heartbeat` / `CompleteTask` / `FailTask` (external-worker lifecycle)
- `GetRateLimitStatus` / `ResetRateLimit`
- Health service (`grpc.health.v1.Health`) + reflection

### SDK (`@duraflow/sdk`)
- `workflow(name, handler, { compensations })` registration
- `step.run(name, fn, opts)` with memoization on `(task_id, step_key)`, `retries`, `rateLimit`
- Compensations as pure functions of saved output, registered by name at module load
- `serialize` / `deserialize` (superjson) with 1 MB cap and `SerializationError`

### Saga Pattern
- LIFO compensation over completed steps, per-compensation timeout (default 30 s)
- Failed compensations route to `dead_letter_queue`; `rolled_back` vs `partial_rollback`
- Example: `apps/engine/tests/workflows/booking-saga.ts`
- Proven end-to-end through the real worker path (`tests/integration/saga-execution.test.ts`)

### Testing
- Three-tier model under `apps/engine/tests/{unit,integration,e2e}/`
- 16 suites, 72 tests, all green (unit + integration + e2e)
- Large-scale stress test (10k tasks) still not done

## Phase 2 - SDK Ecosystem [IN PROGRESS]

Done:
- **Python SDK** (`packages/python-sdk`) - `@workflow` decorator, `StepRunner`, standalone `Worker` over the external-worker RPCs
- **External-worker gRPC RPCs** + `runtime` routing (node = internal executor, python = external worker)
- **Rate limiting** - Redis token-bucket (Lua), per-API presets (OpenAI / Anthropic), integrated into `step.run`

Not started:
- LangChain adapter (`duraflow.wrap(chain)`)
- CrewAI adapter (`duraflow.wrap(crew)`)
- REST API wrapper (Express) + webhooks + scheduled/cron triggers
- CLI (`duraflow init` / `dev` / `deploy` / `runs` / `logs`)

Note: the external-worker (Python) path currently supports whole-task execution only - it does not yet have step memoization or saga semantics through the engine. That parity is an open decision.

## Phase 3 - Dashboard & Production Features [NOT STARTED]

`apps/dashboard/` is an empty placeholder. React dashboard, runs list, step timeline, log viewer, cost/token tracking, human-in-loop approvals, Slack notifications - none of it exists yet.

## Phase 4 - Time Travel + Launch [NOT STARTED]

Fork-and-replay (deterministic replay), TLS, auth, multi-tenancy, OpenTelemetry/Prometheus, launch assets - none of it exists yet.

## Production-Readiness Gaps

Deliberately absent; must be addressed before non-trusted-network deployment:

- **Auth / authorization** - gRPC uses `createInsecure()`; no JWT/API key, no per-RPC permissions
- **Multi-tenancy** - no `tenant_id`, no row-level security, no per-tenant quotas
- **TLS** on the gRPC server
- **OpenTelemetry / Prometheus / structured logging** - logging is TAG-prefixed `console.log`
- **Audit logging**

## Known Issues

Most issues from earlier revisions of this file are now fixed (proto enum drift, missing `started_at`, cancellation not signalling the worker, saga rollback not wired, LIFO tie ordering). Remaining:

1. The external-worker path lacks step/saga semantics (see the Phase 2 note above).
2. No large-scale stress test proving throughput/latency under load.
3. `docs/` VitePress site may lag the code - treat the code as source of truth. (The internal engineering knowledge-base moved to `.claude/` on 2026-08-27 - agent-facing only, not part of the public repo.)
