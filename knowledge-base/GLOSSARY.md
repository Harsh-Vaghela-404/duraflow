# Glossary & Domain Context

## Domain Terms

| Term | Business Definition | Code Representation | Key Files |
|------|--------------------|--------------------|-----------|
| **Task** | The top-level unit of work submitted by a client. Has a name (the workflow to execute), an input payload, and a lifecycle. | `TaskEntity` interface; row in `agent_tasks` table | `apps/engine/src/db/task.entity.ts`, `apps/engine/src/repositories/task.repository.ts` |
| **Workflow** | A named function that defines what work to do. Registered at process startup via `workflow(name, handler)`. Identified by a string name `[a-zA-Z0-9_-]+`, max 100 chars. | `Workflow { name, handler }`; entries in the SDK's `globalRegistry` | `packages/sdk/src/workflow.ts`, `apps/engine/src/workflows/booking-saga.ts` |
| **Step** | An idempotent sub-unit of a workflow, declared inside the handler via `step.run(name, fn, opts)`. Identified by `(task_id, step_key)`. Memoized — re-runs return the cached output. May declare a compensation. | `StepRunsEntity`; row in `step_runs` table; one `step.run(...)` call | `apps/engine/src/db/step_runs.entity.ts`, `apps/engine/src/workers/workflow.worker.ts:124-173` |
| **Saga** | A workflow becomes a saga the moment ANY of its steps declares a `compensation`. When the workflow fails (or is rolled back), compensations run in LIFO order over the completed steps. | `RollbackOrchestrator` is the runtime; the `compensation` field on `StepOptions` is the author-side declaration | `apps/engine/src/services/rollback-orchestrator.ts`, `packages/sdk/src/types.ts` |
| **Compensation** | The undo function for a completed step. Receives the step's output. Registered by string name (`${workflowName}:${stepKey}`) in a process-local registry. Must be idempotent — a retry of the rollback may re-invoke it. | `(output: unknown) => Promise<void>`; entries in `compensationRegistry` (`Map<string, Fn>`) | `packages/sdk/src/compensation.ts`, `apps/engine/src/workers/workflow.worker.ts:141-145` |
| **Dead Letter Queue (DLQ)** | The persistent store of failed compensation attempts. Operators inspect the table and call `dlqRepo.retry(id)` to re-run a failed compensation. **No automatic retries.** | `dead_letter_queue` table | `apps/engine/src/repositories/dlq.repository.ts`, `apps/engine/src/db/dead_letter_queue.entity.ts` |
| **Reaper** | Background service that recovers tasks abandoned by dead workers. Re-queues stale `running` tasks (`heartbeat_at < NOW() - 300s`) or fails them if exhausted (`retry_count >= max_retries`). | `Reaper` class, started by `index.ts` | `apps/engine/src/services/reaper.ts` |
| **Leader election** | Redis-backed distributed lock that ensures only one process runs the reaper at a time. Key: `duraflow:reaper:leader`. Acquired via `SET NX EX`, renewed via Lua `EXPIRE`. | `LeaderElector` class | `apps/engine/src/services/leaderelector.ts` |
| **Heartbeat** | A `setInterval` (default 5s) that updates `agent_tasks.heartbeat_at` while a task is running. The reaper uses this column to detect dead workers. | `HeartbeatService.start(taskId)` / `stop(taskId)` | `apps/engine/src/services/heartbeat.service.ts` |
| **Backpressure** | Two thresholds the poller respects before pulling more work: Piscina queue size (`MAX_QUEUE_SIZE`) and event-loop lag (`MAX_EVENT_LOOP_LAG`). Either crossing triggers a 1-second pause. | `checkBackpressure` closure in `index.ts:69-86` | `apps/engine/src/index.ts`, `apps/engine/src/services/event-loop-monitor.ts` |
| **IPC** | Inter-thread communication between the main thread and Piscina worker. Uses `MessageChannel` / `MessagePort`. Each request has a UUID id and a 30s timeout. | `IPCClient` class in the worker, `handleWorkerMessage` in the executor | `apps/engine/src/workers/workflow.worker.ts:65-122`, `apps/engine/src/services/workflow-executor.ts:67-94,110-147` |
| **Step Retry** | When a step throws and `attempt <= retries`, the engine schedules a retry by writing `status='pending'` and `scheduled_at = NOW() + delay` to the task row. Communicated across the worker boundary via `StepRetryError` → `{ __stepRetry: true, delay, attempt, originalError }`. | `StepRetryError`; `scheduleRetry` SQL | `apps/engine/src/errors/step-retry.error.ts`, `apps/engine/src/repositories/task.repository.ts:83-105` |
| **Worker ID** | An ephemeral identifier for each engine process, assigned at startup as `worker-${uuid().slice(0,8)}`. Stored in `agent_tasks.worker_id` while a task is in `running` state. Cleared when re-queued or completed. | `config.workerId` in `index.ts:25` | `apps/engine/src/index.ts`, `apps/engine/src/repositories/task.repository.ts:64-81` |

## Implicit Conventions

- **One bootstrap site** — All wiring is in `apps/engine/src/index.ts`. Adding services or repositories elsewhere via globals/singletons breaks the dependency-direction-is-visible invariant. Example: `apps/engine/src/index.ts:29-95`.
- **Class per table** — Repositories are one-class-per-table with `constructor(private readonly pool: Pool)`. No `BaseRepository`, no generic helper. Example: `apps/engine/src/repositories/task.repository.ts`, `step.repository.ts`, `dlq.repository.ts`.
- **TAG at the top of every logging module** — `const TAG = '[module-name]';` (kebab-case in brackets). Used as `${TAG} <msg>`. Existing TAGs: `[duraflow]`, `[engine]`, `[grpc]`, `[poller]`, `[heartbeat]`, `[reaper]`, `[leader]`, `[rollback]`, `[executor]`, `[worker]`.
- **`{ message, name, stack }` shape for errors stored in JSONB** — `task.repository.ts:38-42`, `step.repository.ts` (`updateFailed`), `rollback-orchestrator.ts:104-107`. Operators read these columns directly.
- **Compensation key is `${workflowName}:${stepKey}`** — Not just `stepKey`. See `workflow.worker.ts:143`.
- **The status string in DB is lowercase; the gRPC enum is SCREAMING_SNAKE** — Handler converts via `.toUpperCase()` on read. See `agent.service.ts:44`.
- **Workflows under `apps/engine/src/workflows/` import only from `@duraflow/sdk`** — The SDK is the boundary. Reaching into engine internals from a workflow file is a code review block.
- **The proto package is loaded at runtime via `protoLoader.loadSync`** — Not from the generated TS in `packages/proto/generated/`. The generated types exist but are not yet wired into the engine.
- **`registerCompensation` is called once at workflow file load** in the worker (`workflow.worker.ts:24-35`). For tests, register in `beforeEach`.
- **Sagas decide their own terminal status** — All compensations succeeded → `rolled_back`. One or more landed in DLQ → `partial_rollback`. Never `failed` for a rollback outcome.
- **Pool size is 20** — Set in `db/index.ts:11`. The Piscina worker pool size is `max(2, cpuCores - 1)`. Threads share that one pool through IPC.

## Status & Lifecycle Enums

### `taskStatus` (DB values are lowercase strings)

Source: `apps/engine/src/db/task.entity.ts:1-9`

| Value | Meaning | Transitions To | Business Rule |
|-------|---------|---------------|---------------|
| `pending` | Awaiting a worker. New row default. Also the state after a successful `scheduleRetry` or `Reaper.requeueStaleTasks`. | `running` (via `Poller.dequeue`), `cancelled` (via `CancelTask`) | The only state where `scheduled_at` may be in the future. |
| `running` | A worker has claimed it (`worker_id` set, `heartbeat_at` advancing every 5s). | `completed`, `failed` (via executor), `cancelled` (via `CancelTask`), `pending` (via Reaper re-queue) | Reaper re-queues if `heartbeat_at < NOW() - 300s` AND `retry_count < max_retries`. Otherwise transitions directly to `failed`. |
| `completed` | Workflow handler returned successfully; `output` is set; `completed_at` is set. | (terminal) | `Reaper` and `Poller` skip terminal states. |
| `failed` | Workflow threw and retries are exhausted; `error` is set; `completed_at` is set. | `rolled_back` or `partial_rollback` only if `RollbackOrchestrator.rollback` is invoked. | The executor itself does not auto-trigger rollback today — tests do. |
| `cancelled` | A client invoked `CancelTask` while the task was `pending` or `running`. | (terminal) | Does NOT auto-rollback completed steps. See GOTCHAS. |
| `rolled_back` | All completed-step compensations succeeded. | (terminal) | Set only by `RollbackOrchestrator.rollback` when `failed === 0`. |
| `partial_rollback` | One or more compensations failed and landed in DLQ. | (terminal until DLQ retry) | Set only by `RollbackOrchestrator.rollback` when `failed > 0`. |

### `stepStatus`

Source: `apps/engine/src/db/step_runs.entity.ts:1-7`

| Value | Meaning | Transitions To | Business Rule |
|-------|---------|---------------|---------------|
| `pending` | Step row created (`createOrFind`) but not yet attempted. | `running` | Initial state after `step.run` first encounters this `(task_id, step_key)`. |
| `running` | The worker is executing the step function. | `completed`, `failed` | Attempt counter is incremented before each retry. |
| `completed` | Step function returned successfully; `output` is set. Compensation (if any) is registered under `${workflowName}:${stepKey}`. | (terminal for happy path; rollback may set `compensated_at`) | Memoized — a re-run of the workflow hits the cache and skips re-execution. |
| `failed` | Step exhausted retries; `error` is set. | (terminal) | The parent task transitions to `failed`. |
| `cancelled` | Reserved enum value; not currently written by any service. | — | Future cancellation propagation. |

### gRPC `TaskStatus` Enum (proto)

Source: `packages/proto/agent.service.proto:6-13`

| Proto Value | DB Equivalent | Notes |
|-------------|---------------|-------|
| `TASK_STATUS_UNSPECIFIED` | — | Proto3 default; not used in handler responses. |
| `PENDING` | `pending` | Returned via `.toUpperCase()` on the DB value. |
| `RUNNING` | `running` | |
| `COMPLETED` | `completed` | |
| `FAILED` | `failed` | |
| `CANCELLED` | `cancelled` | |

**Note:** The proto enum is missing `ROLLED_BACK` and `PARTIAL_ROLLBACK`. Calling `GetTaskStatus` on a rolled-back task returns the uppercased string `'ROLLED_BACK'` / `'PARTIAL_ROLLBACK'` in the response field, which is NOT a valid proto enum value. Clients deserializing the response as the typed proto may see `TASK_STATUS_UNSPECIFIED` instead. Worth flagging when wiring real clients.

## Implicit Conventions in Tests

- **Three test tiers** — `apps/engine/tests/{unit,integration,e2e}`. Unit mocks repositories with `jest.fn()`; integration uses `createTestPool()` against a real DB; e2e spawns the engine subprocess and drives it with a real `@grpc/grpc-js` client.
- **`registerCompensation` in `beforeEach`** for integration tests that exercise rollback. The registry is process-local; tests must seed it.
- **`clearTables(pool)` + `redis.flushall()`** in `beforeEach` for any integration test that touches state.
- **`pool.end()` + `redis.quit()`** in `afterAll`. Forgetting either makes Jest hang.
- **`jest.config.js` sets `testTimeout: 30000`** — long-running integration tests are expected.

## Workflow Naming Rules

From `packages/sdk/src/workflow.ts:12-22`:

- Pattern: `[a-zA-Z0-9_-]+`
- Max length: 100 chars
- Must be unique within the process (a second registration throws)

These rules apply to the **workflow name** (e.g., `booking-saga`). Step keys (`book-flight`) are not validated by the SDK — they are validated by the database's `UNIQUE(task_id, step_key)` constraint at insert time.
