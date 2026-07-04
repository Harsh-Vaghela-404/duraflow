# Architecture

## Tech Stack

| Library | Version | Role | Key Files |
|---------|---------|------|-----------|
| `@grpc/grpc-js` | 1.9.0 | gRPC server (insecure credentials, no auth) | `apps/engine/src/grpc/server.ts` |
| `@grpc/proto-loader` | 0.7.x | Runtime proto loading | `apps/engine/src/grpc/server.ts` |
| `@grpc/reflection` | 1.0.4 | gRPC reflection for grpcurl | `apps/engine/src/grpc/server.ts:57-62` |
| `pg` | 8.17.2 | Raw PostgreSQL driver (no ORM) | `apps/engine/src/db/index.ts:8-15` |
| `ioredis` | 5.3.0 | Redis client (leader election only) | `apps/engine/src/db/index.ts:17-21` |
| `piscina` | 5.1.4 | Worker thread pool for step execution | `apps/engine/src/services/workflow-executor.ts:32-49` |
| `superjson` | 2.2.6 | Payload serialization (Date/Map/Set/Error) with 1MB cap | `packages/sdk/src/utils/serialization.ts` |
| `ts-proto` | 1.181.2 | Generate TS types from proto (generated dir not yet wired into engine) | `packages/proto/generated/` |
| `jest` + `ts-jest` | 29.5.0 | Three-tier test runner | `apps/engine/jest.config.js` |
| `turbo` | 2.7.5 | Monorepo task orchestrator | `turbo.json` |
| `tsx` | n/a | TS runtime for dev + worker children | `apps/engine/package.json` |
| `uuid` | 10.x | Generates `worker-<id>` at startup only (Postgres generates row UUIDs) | `apps/engine/src/index.ts:13,25` |
| `dotenv` | 17.x | Load `.env` for engine + migrate | `apps/engine/src/db/index.ts:1`, `apps/engine/src/index.ts:1` |
| `prettier` | 3.7.x | Root formatter (integrated with ESLint via `eslint-config-prettier`) | `package.json:format`, `eslint.config.mjs` |
| TypeScript | 5.9.2 | strict + noUncheckedIndexedAccess + noImplicitReturns | `packages/typescript-config/base.json` |

## Monorepo Layout

| Workspace | Path | Role |
|-----------|------|------|
| `@duraflow/engine` | `apps/engine` | gRPC server, poller, workers, repositories, saga orchestration |
| `@duraflow/sdk` | `packages/sdk` | Workflow registration, `step.run` runner, compensation registry, serialize/deserialize |
| `@duraflow/proto` | `packages/proto` | `.proto` files + `ts-proto` generated TS (not yet imported by engine) |
| `@duraflow/typescript-config` | `packages/typescript-config` | Shared `base.json`, `nextjs.json`, `react-library.json` |

`apps/dashboard/` exists but is empty (no `package.json`, no sources). `docs/` is a Docusaurus site published to Vercel and is NOT part of the workspaces.

## Module Index

### Bootstrap & Entry

- **`apps/engine/src/index.ts`** — Single bootstrap. Reads `process.env`, constructs pool / redis / piscina / repos / services in order, starts gRPC + Reaper + Poller. Wires `SIGTERM`/`SIGINT`/`SIGUSR2` to graceful shutdown. **All wiring lives here.**
- **`apps/engine/src/task-runner.ts`** — `runTask(executor, heartbeat, task)`: starts heartbeat, hands the task to `WorkflowExecutor.execute`, stops heartbeat in `finally`.
- **`apps/engine/src/grpc/server.ts`** — `createGrpcServer(pool, redis)` + `startGrpcServer(server, port)`. Loads `agent.service.proto` and `health.service.proto` at runtime, registers reflection.

### gRPC Service Layer (`apps/engine/src/grpc/`)

- **`agent.service.ts`** — `AgentServiceImpl` — twelve RPCs: `submitTask`, `getTaskStatus`, `cancelTask`, `getStep`, `completeStep`, `failStep`, `dequeueTask`, `heartbeat`, `completeTask`, `failTask`, `getRateLimitStatus`, `resetRateLimit`. TAG = `[agent-service]`.
- **`health.service.ts`** — `HealthService` — `check` + `watch` for `grpc.health.v1.Health`.

All twelve AgentService RPCs are wired in `server.ts`. **Two execution models share this surface:** the *internal Node runtime* (poller → Piscina worker) drives `submitTask`/`getTaskStatus`/`cancelTask` plus the step RPCs; the *external-worker runtime* (e.g. the Python SDK) pulls work via `dequeueTask`/`heartbeat`/`completeTask`/`failTask`. The `runtime` column on `agent_tasks` (`'node'` | `'python'`) routes each task. Note: the external path does whole-task execution only — no step memoization or saga semantics through the engine yet.

### Services (`apps/engine/src/services/`)

| File | Class | TAG | Purpose |
|------|-------|-----|---------|
| `poller.ts` | `Poller` | `[poller]` | Claims tasks via `taskRepo.dequeue` with exponential backoff (100→200→400→500ms cap). Respects `checkBackpressure()` callback. |
| `heartbeat.service.ts` | `HeartbeatService` | `[heartbeat]` | `setInterval` per task updating `agent_tasks.heartbeat_at`. Default 5s. |
| `reaper.ts` | `Reaper` | `[reaper]` | Re-queues stale `running` tasks (heartbeat older than 300s) or fails them if `retry_count >= max_retries`. Singleton via `LeaderElector`. |
| `leader-elector.ts` | `LeaderElector` | `[leader]` | Redis `SET key val EX NX` + Lua `EXPIRE` for check-and-renew. Key: `duraflow:reaper:leader`. TTL: `LEADER_TTL_SECONDS` (default 30). |
| `rollback-orchestrator.ts` | `RollbackOrchestrator` | `[rollback]` | LIFO compensation over completed steps. Per-compensation 30s timeout. Failed compensations → DLQ. |
| `workflow-executor.ts` | `WorkflowExecutor` + `createPiscinaPool` | `[executor]` | Dispatches task to Piscina worker via `MessageChannel`. Owns IPC reply handler (`STEP_FIND`, `STEP_CREATE_OR_FIND`, `STEP_COMPLETE`, `STEP_FAIL`, `STEP_INCREMENT`). Translates `__stepRetry` → `taskRepo.scheduleRetry`. |
| `event-loop-monitor.ts` | `EventLoopMonitor` | n/a | Tracks event-loop lag (ms) used by `checkBackpressure` in `index.ts:69-86`. |
| `index.ts` | re-exports | n/a | Barrel for the above + `createPiscinaPool`. |

### Repositories (`apps/engine/src/repositories/`)

| File | Class | Table | Notes |
|------|-------|-------|-------|
| `task.repository.ts` | `TaskRepository` | `agent_tasks` | `create`, `findById`, `updateStatus`, `updateCompleted`, `fail`, `updateHeartbeat`, `completeRunning`, `failRunning`, `dequeue`, `scheduleRetry`. `dequeue` uses `FOR UPDATE SKIP LOCKED` inside a CTE. |
| `step.repository.ts` | `StepRepository` | `step_runs` | `findByTaskAndKey`, `createOrFind`, `updateCompleted`, `updateFailed`, `incrementAttempt`, `findCompletedWithCompensation`, `markCompensated`. |
| `dlq.repository.ts` | `DeadLetterQueueRepository` | `dead_letter_queue` | `insert(taskId, stepId, errorContext)`. Manual retry surface is `dlqRepo.retry(id)` (operator-driven). |

### Workers (`apps/engine/src/workers/`)

- **`step-worker.ts`** — Piscina worker entry. CommonJS via `module.exports = executeWorkflow`. TAG = `[worker]`. Contains an in-file `IPCClient` class (UUID-keyed `pending` map, 30s timeout per request, `timeout.unref()`). Builds `StepRunner` and calls the registered workflow handler. Translates `StepRetryError` thrown from `step.run` into `{ __stepRetry, delay, attempt, originalError }` for the main thread to detect. Loads user workflows from `process.env.DURAFLOW_WORKFLOWS` (comma-separated paths) on module load.

### Workflows (`apps/engine/src/workflows/`)

- **`booking-saga.ts`** — Example three-step saga: `book-flight` → `book-hotel` → `book-car` → `charge-payment` (always throws). Demonstrates compensation registration through `step.run`'s `compensation` option. The compensation key passed to the registry is `${workflowName}:${stepKey}` (e.g., `booking-saga:book-flight`) — see `step-worker.ts:142-145`.
- **`apps/engine/src/workflows.ts`** — Workflow re-export module loaded by `DURAFLOW_WORKFLOWS`.

### Data Layer (`apps/engine/src/db/`)

- **`index.ts`** — `createPool()` (reads `DATABASE_URL`), `createRedis()` (reads `REDIS_URL`, `lazyConnect: true`). Re-exports the two entity modules.
- **`task.entity.ts`** — `taskStatus` enum (`pending`, `running`, `completed`, `failed`, `cancelled`, `rolled_back`, `partial_rollback`) and `TaskEntity` interface.
- **`step_runs.entity.ts`** — `stepStatus` enum and `StepRunsEntity` interface (`compensation_fn: string | null`, `compensated_at: Date | null`).
- **`dead_letter_queue.entity.ts`** — `DeadLetterQueueEntity` interface.
- **`migrate.ts`** — Manual migration script. Creates the three tables and three indexes, then exits. Run from inside `apps/engine` with `tsx src/db/migrate.ts`. Never auto-run on startup.

### SDK (`packages/sdk/src/`)

| File | Exports |
|------|---------|
| `workflow.ts` | `workflow(name, handler)`, `globalRegistry`. Name validation: `[a-zA-Z0-9_-]+`, ≤100 chars, unique. |
| `types.ts` | `WorkflowContext`, `StepRunner`, `StepOptions` (`{ compensation?, retries? }`). |
| `compensation.ts` | `compensationRegistry`, `registerCompensation(name, fn)`. **Process-local.** Tests must register before invoking the orchestrator. |
| `utils/serialization.ts` | `serialize`, `deserialize`, `SerializationError`. 1MB payload limit enforced. |
| `index.ts` | Barrel for all of the above. |

### Errors & Utilities

- **`apps/engine/src/errors/step-retry.error.ts`** — `StepRetryError(delay, attempt, originalError)`. Thrown inside `createStepRunner.run` when `currentAttempt <= maxRetries` (`step-worker.ts:162`).
- **`apps/engine/src/utils/backoff.ts`** — `calculateBackOff(attempt)` exponential backoff helper.
- **`apps/engine/src/constants/lock_ids.ts`** — Shared constant identifiers.

## Data Architecture

### PostgreSQL 16 (`postgres:16-alpine`)

| Table | Purpose | Key Columns | Written By | Read By |
|-------|---------|-------------|------------|---------|
| `agent_tasks` | Top-level units of work | `id (uuid PK)`, `workflow_name`, `status`, `input/output/error (jsonb)`, `priority`, `scheduled_at`, `heartbeat_at`, `worker_id`, `retry_count`, `max_retries`, `created_at`, `updated_at`, `deleted_at` | `TaskRepository`, `Reaper` | `TaskRepository`, `Reaper`, `Poller (via dequeue)` |
| `step_runs` | Idempotent sub-units of a task | `id`, `task_id (FK)`, `step_key`, `status`, `attempt`, `input/output/error (jsonb)`, `compensation_fn (text)`, `compensated_at`, `started_at`, `completed_at`. **UNIQUE(task_id, step_key)**. | `StepRepository` (via worker IPC) | `StepRepository`, `RollbackOrchestrator` |
| `dead_letter_queue` | Failed compensation attempts | `id`, `task_id`, `step_id`, `error (jsonb)`, `retry_count`, `created_at` | `DeadLetterQueueRepository` (from `RollbackOrchestrator`) | `DeadLetterQueueRepository` (operator retry) |

### Indexes (from `apps/engine/src/db/migrate.ts`)

| Index | Columns | Predicate | Purpose |
|-------|---------|-----------|---------|
| `idx_agent_tasks_status_scheduled_priority` | `(status, scheduled_at, priority DESC)` | `WHERE status = 'pending'` | Partial index for the dequeue path |
| `idx_step_runs_task_id` | `(task_id)` | — | Lookup steps by task |
| `idx_dead_letter_queue_task_id` | `(task_id)` | — | Lookup DLQ entries by task |

### Entity Relationships

- `step_runs.task_id` → `agent_tasks.id` (`ON DELETE CASCADE`).
- `dead_letter_queue.task_id` and `dead_letter_queue.step_id` reference `agent_tasks` and `step_runs` respectively but **without a FK** (intentional — DLQ rows survive purge).

### Redis

Used for distributed leader election only. Single key: `duraflow:reaper:leader`. Value: `<workerId>`. TTL: `LEADER_TTL_SECONDS` (default 30s). Renewed via Lua `EXPIRE` every TTL/2 seconds. No generic caching.

## API Surface — gRPC

Defined in `packages/proto/agent.service.proto`. Bound on `0.0.0.0:50051` (configurable via `PORT` env). Insecure credentials — no TLS, no auth.

### AgentService (`packages/proto/agent.service.proto`)

| RPC | Wired in `server.ts`? | Handler | Auth | Description |
|-----|----------------------|---------|------|-------------|
| `SubmitTask(workflow_name, input bytes)` → `task_id` | Yes (line 51) | `AgentServiceImpl.submitTask` | none | Inserts a `pending` row in `agent_tasks`. |
| `GetTaskStatus(task_id)` → `{status, output bytes, error bytes}` | Yes (line 52) | `AgentServiceImpl.getTaskStatus` | none | Looks up by id; returns `NOT_FOUND` if missing. Status is returned as the enum string `.toUpperCase()` (e.g., `'PENDING'`). |
| `CancelTask(task_id)` → `success` | Yes (line 53) | `AgentServiceImpl.cancelTask` | none | Sets status to `cancelled` if currently `pending` or `running`. `FAILED_PRECONDITION` otherwise. For `running` tasks, asynchronously triggers `RollbackOrchestrator` so completed steps are compensated. |
| `GetStep(task_id, step_key)` → `{found, completed, output bytes}` | Yes (line 60) | `AgentServiceImpl.getStep` | none | SDK crash recovery — checks if a step already completed. |
| `CompleteStep(task_id, step_key, output bytes)` → `success` | Yes (line 61) | `AgentServiceImpl.completeStep` | none | SDK crash recovery — marks a step completed. |
| `FailStep(task_id, step_key, error bytes)` → `success` | Yes (line 62) | `AgentServiceImpl.failStep` | none | SDK crash recovery — marks a step failed. |

### HealthService (`packages/proto/health.service.proto`)

| RPC | Handler | Description |
|-----|---------|-------------|
| `Check(service)` → `status` | `HealthService.check` | gRPC health check — used by load balancers / orchestrators. |
| `Watch(service)` → `stream status` | `HealthService.watch` | Streaming variant. |

### gRPC Server Options (`server.ts:35-41`)

| Option | Value | Notes |
|--------|-------|-------|
| `grpc.max_receive_message_length` | 4 MB | Caps inbound payload |
| `grpc.max_send_message_length` | 4 MB | Caps outbound payload |
| `grpc.keepalive_time_ms` | 30000 | TCP keepalive |
| `grpc.keepalive_timeout_ms` | 10000 | |
| `grpc.keepalive_permit_without_calls` | 1 | |

### gRPC Status Code Usage

| Code | Where |
|------|-------|
| `INVALID_ARGUMENT` | Missing/malformed `workflow_name`, missing/wrong-typed `task_id`. |
| `NOT_FOUND` | Unknown `task_id`. |
| `FAILED_PRECONDITION` | Cancelling a task already in a terminal state. |
| `INTERNAL` | Catch-all for uncaught errors in any handler. |

## Authentication & Authorization

| Component | Type | File | Description |
|-----------|------|------|-------------|
| — | — | — | **No authentication exists today.** Server runs `grpc.ServerCredentials.createInsecure()` (`server.ts:74`). Trusted-internal-network assumption. |

If auth is added in the future, it should be a single gRPC interceptor reading from `Metadata`, not per-RPC checks. There is no permission/role model.

## Infrastructure

| Service | Purpose | Client Location | Config Location |
|---------|---------|-----------------|-----------------|
| PostgreSQL 16 (`postgres:16-alpine`) | Source of truth — all task / step / DLQ rows | `apps/engine/src/db/index.ts:8-15` | `DATABASE_URL` (and Pool max=20, idleTimeout=30s, connectionTimeout=2s) |
| Redis 7 (`redis:7-alpine`) | Leader election ONLY | `apps/engine/src/db/index.ts:17-21` | `REDIS_URL` |
| Piscina worker pool | Step execution off the main thread | `apps/engine/src/services/workflow-executor.ts:32-49` | `maxThreads = max(2, cpuCores - 1)`, `minThreads = 1`, `maxQueue = 10000`, `idleTimeout = 30000` |
| Qdrant (`qdrant/qdrant`) | Provisioned in `docker-compose.yml` for future vector search | not wired | ports 6333 / 6334 |
| `@grpc/grpc-js` server | Inbound RPC | `apps/engine/src/grpc/server.ts` | `PORT` (default 50051) |

## Environment Variables (read directly from `process.env`)

| Var | Default | Read in | Purpose |
|-----|---------|---------|---------|
| `DATABASE_URL` | — | `db/index.ts:10` | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | `db/index.ts:18` | Redis connection string |
| `PORT` | `50051` | `index.ts:20` | gRPC bind port |
| `REAPER_STALE_THRESHOLD` | `300` (seconds) | `index.ts:21` | Heartbeat-age threshold for reaping |
| `REAPER_INTERVAL` | `10000` (ms) | `index.ts:22` | Reaper tick interval |
| `MAX_QUEUE_SIZE` | `1000` | `index.ts:23` | Piscina backpressure threshold |
| `MAX_EVENT_LOOP_LAG` | `100` (ms) | `index.ts:24` | Event-loop backpressure threshold |
| `LEADER_TTL_SECONDS` | `30` | `leader-elector.ts:15` | Redis lease TTL for reaper leader |
| `DURAFLOW_WORKFLOWS` | — | `step-worker.ts:20`, `index.ts:46` | Comma-separated list of workflow files to `require()` at worker startup |

## Verification Commands (from `package.json`)

```
typecheck: turbo run check-types
lint:      turbo run lint                            # eslint.config.mjs at root — typescript-eslint + no-floating-promises
test:      npm run test --workspace=apps/engine      # unit always; integration/e2e need .env + docker
build:     turbo run build
format:    prettier --write "**/*.{ts,tsx,md}"
```

## Frontend Architecture

Not applicable. `apps/dashboard/` is an empty placeholder.
