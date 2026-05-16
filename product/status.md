# Status

> The honest state of the Duraflow build. Updated 2026-05-17.

We try hard not to lie about state. Every claim in this file maps to a file or directory in the repo. If you find a discrepancy, it's a bug — open an issue.

## TL;DR

- **Phase 1 — the engine** is **shipped**. Durable execution, sagas, dead-letter queue, reaper, leader election, worker threads, backpressure — all built and tested.
- **Public documentation** is **shipped** at [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app).
- **Phase 2 — SDK ecosystem** is **next**. Python SDK, LangChain & CrewAI adapters, REST API, CLI — not started.
- **Phase 3 — dashboard, cost tracking, human-in-loop** is after that.
- **Phase 4 — time travel debugging + launch** is after that.

The engine is solid enough today that you could self-host it, write a workflow against the TypeScript SDK, and run it in production. You'd be an early adopter — there's no hosted cloud, no public npm packages, no auth layer, no observability stack — but the core promise (durability + sagas) works.

## Phase 1 — Core Engine [SHIPPED]

### Infrastructure
- ✅ Turborepo monorepo with npm workspaces (`apps/engine`, `packages/sdk`, `packages/proto`, `packages/typescript-config`)
- ✅ Docker Compose for local dev (`postgres:16`, `redis:7`, `qdrant/qdrant`)
- ✅ TypeScript 5.9 strict everywhere

### Data Layer
- ✅ Three tables — `agent_tasks`, `step_runs`, `dead_letter_queue` — with appropriate indexes
- ✅ Manual migration script (no auto-migrate on startup, by design)
- ✅ Raw `pg@8.17` with parameterized SQL; no ORM
- ✅ `FOR UPDATE SKIP LOCKED` as the queue primitive

### Engine Services
- ✅ Poller with exponential backoff (100→200→400→500 ms cap)
- ✅ Heartbeat service (5 s interval per task)
- ✅ Reaper for stale-task recovery (heartbeat older than 300 s → re-queue or fail)
- ✅ Redis leader election with Lua check-and-renew (`SET NX EX` + atomic EXPIRE)
- ✅ Backpressure: pauses ingestion when `queueSize >= MAX_QUEUE_SIZE` or `eventLoopLag >= MAX_EVENT_LOOP_LAG`
- ✅ Piscina worker thread pool (size = `max(2, cpuCores - 1)`)
- ✅ MessageChannel IPC between main thread and workers with 30 s per-request timeout

### gRPC Surface (`@grpc/grpc-js` 1.9)
- ✅ `SubmitTask`
- ✅ `GetTaskStatus`
- ✅ `CancelTask`
- ✅ Health service (`grpc.health.v1.Health`)
- ✅ Reflection (for `grpcurl` debugging)
- ⚠️ `GetStep` / `CompleteStep` / `FailStep` declared in proto but **not yet wired** — reserved for SDK crash recovery

### SDK (`@duraflow/sdk`)
- ✅ `workflow(name, handler)` registration
- ✅ `step.run(name, fn, opts)` with memoization on `(task_id, step_key)`
- ✅ `compensation` option on `StepOptions`
- ✅ `retries` option with `StepRetryError` and exponential backoff
- ✅ `serialize` / `deserialize` (superjson) with 1 MB cap and `SerializationError`
- ✅ `registerCompensation(name, fn)` for manual registration

### Saga Pattern
- ✅ LIFO compensation over completed steps with `compensation_fn`
- ✅ Per-compensation timeout (default 30 s)
- ✅ Failed compensations route to `dead_letter_queue`
- ✅ Terminal task status `rolled_back` (all succeeded) or `partial_rollback` (some failed)
- ✅ Example workflow: `apps/engine/src/workflows/booking-saga.ts` (3-step flight/hotel/car/payment)

### Testing
- ✅ Three-tier model under `apps/engine/tests/{unit,integration,e2e}/`
- ✅ **Unit (7)**: backoff, heartbeat, leader-elector, poller, reaper, step-repository, task-repository
- ✅ **Integration (4)**: crash-recovery, dequeue-concurrent, saga, workflow-executor
- ✅ **E2E (1)**: grpc (spawns engine subprocess, drives with real gRPC client)
- ⚠️ Concurrency stress test exists but only exercises 10 tasks. The original plan called for a 10,000-task stress test. **Not yet done.**

### Documentation
- ✅ VitePress site at [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app) — installation, tutorial, core concepts, sagas deep-dive, API reference, database schema
- ✅ Code-level reference in `knowledge-base/` (ARCHITECTURE, PATTERNS, DEPENDENCY-MAP, FLOWS, GOTCHAS, GLOSSARY)
- ✅ Project rules and skills under `.claude/` for Claude Code users

## Phase 2 — SDK Ecosystem [NOT STARTED]

These are planned but **no code exists yet**:

- ❌ Python SDK (`pip install duraflow`)
- ❌ LangChain adapter (`duraflow.wrap(chain)`)
- ❌ CrewAI adapter (`duraflow.wrap(crew)`)
- ❌ REST API wrapper (Express)
- ❌ Webhook triggers
- ❌ Scheduled runs (cron)
- ❌ CLI (`duraflow init` / `dev` / `deploy` / `runs` / `logs`)
- ❌ Rate limiting (Redis token bucket, per-API limits for OpenAI / Anthropic)

## Phase 3 — Dashboard & Production Features [NOT STARTED]

`apps/dashboard/` exists as an empty placeholder directory. None of the following exists in code:

- ❌ React dashboard application
- ❌ Runs list page
- ❌ Run detail / step timeline / log viewer
- ❌ Slack notifications
- ❌ Usage dashboard
- ❌ Token / cost tracking (no `tokens` column, no cost service)
- ❌ Human-in-loop approvals (`ctx.waitForApproval`, approval table)
- ❌ Workflow management UI

## Phase 4 — Time Travel + Launch [NOT STARTED]

- ❌ Fork-run schema
- ❌ Replay API (re-execute from arbitrary step with modified input)
- ❌ Time-travel UI
- ❌ Demo video, Product Hunt assets, Hacker News post, launch content
- ❌ Production deployment infrastructure (CI/CD, monitoring, alerting)

## Production-Readiness Gaps

These deliberately do not exist today and need to be addressed before non-trusted-network deployment:

- ❌ **Authentication / authorization** — gRPC uses `createInsecure()`. There is no JWT, no API key, no per-RPC permission model. Assumption is a trusted private network.
- ❌ **Multi-tenancy** — no `tenant_id` columns, no row-level security, no per-tenant quotas.
- ❌ **TLS** — no SSL credentials on the gRPC server.
- ❌ **OpenTelemetry / Prometheus / structured logging** — logging is `console.log` with TAG prefixes (e.g., `[poller]`, `[reaper]`); no metrics export, no traces.
- ❌ **Audit logging** — no `audit_log` table or service-level recording of sensitive operations.
- ❌ **No ESLint config file** — `lint` scripts exist in every workspace but no `eslint.config.*` is present, so `turbo run lint` is a no-op today. `turbo run check-types` and `turbo run build` are the hard guarantees.

## Known Issues to Fix

These are in the code or in the proto and need correcting:

1. **Proto enum drift.** `agent.service.proto` is missing `ROLLED_BACK` and `PARTIAL_ROLLBACK`. The handler returns them as uppercase strings, but typed proto clients will see `TASK_STATUS_UNSPECIFIED`.
2. **Cancellation does not signal the worker.** `CancelTask` flips the row to `cancelled`, but if the worker is mid-execution, it can still flip back to `completed`. There is no in-flight cancellation today.
3. **Cancellation does not auto-rollback.** A cancelled task with completed steps is NOT routed to `RollbackOrchestrator` automatically.
4. **`GetStep` / `CompleteStep` / `FailStep` RPCs declared but not wired.** Clients calling them get `UNIMPLEMENTED`. Reserved for future SDK crash-recovery features.
5. **No `started_at` column on `agent_tasks`** despite some older docs referencing it. The actual column set is in the migration script and the entity interface.

## Update Cadence

This file is the single source of truth for "where are we." Whenever a phase ships or a known issue is fixed, this file gets updated in the same commit. If you spot drift, it is a bug — open an issue or PR.
