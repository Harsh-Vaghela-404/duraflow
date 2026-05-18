# Gotchas

## Critical Rules

### Parameterized SQL only — never interpolate

Every query uses `$1..$N` placeholders. There is no exception. The codebase uses raw `pg` without an ORM, so SQL injection is exactly as easy as letting it happen.

**Affected Files:**
- `apps/engine/src/repositories/task.repository.ts`
- `apps/engine/src/repositories/step.repository.ts`
- `apps/engine/src/repositories/dlq.repository.ts`
- `apps/engine/src/services/reaper.ts` (inline `pool.query` for the two reap UPDATEs)

---

### `FOR UPDATE SKIP LOCKED` is the dequeue idiom — never plain `SELECT ... LIMIT N` for queue work

The atomic CTE in `TaskRepository.dequeue` claims and updates a row in one statement. Any new "worker pulls work" path (DLQ retry, scheduled background jobs) must copy this pattern — plain `SELECT ... LIMIT N` will race across multiple worker instances.

**Affected Files:**
- `apps/engine/src/repositories/task.repository.ts:64-81`

---

### gRPC handlers are callback-style — never return a Promise, never throw

Handler signature is `(call, callback) => void`. The body wraps everything in `try/catch` and ends with `callback(null, response)` or `callback({ code: grpc.status.X, message })`. Returning a Promise makes gRPC hang. Throwing makes gRPC respond `UNKNOWN` and lose context.

**Affected Files:**
- `apps/engine/src/grpc/agent.service.ts:16-78`
- `apps/engine/src/grpc/health.service.ts`

---

### Compensation registry is process-local

`compensationRegistry` is a `Map` in module scope. Workflows register their compensations when the workflow file is `require()`-ed at worker startup (`apps/engine/src/workers/workflow.worker.ts:24-35`). Integration tests must explicitly call `registerCompensation('${workflowName}:${stepKey}', fn)` in `beforeEach` (`apps/engine/tests/integration/saga.test.ts:77-79`). If the registry key is missing, the orchestrator routes that step to `dead_letter_queue` and continues — the compensation simply does not run.

**Affected Files:**
- `packages/sdk/src/compensation.ts`
- `apps/engine/src/workers/workflow.worker.ts:141-145` (key construction)
- `apps/engine/src/services/rollback-orchestrator.ts:65-84`
- `apps/engine/tests/integration/saga.test.ts:77-79`

---

### Compensation registry key is `${workflowName}:${stepKey}`, NOT just `stepKey`

The worker registers compensations using `${workflowName}:${stepKey}` as the key (`workflow.worker.ts:143`). The orchestrator looks them up by the same key (read out of `step_runs.compensation_fn`, which the worker also wrote with the prefixed key — see `workflow.worker.ts:148-153`). If you `registerCompensation('book-flight', fn)` in a test, the lookup at rollback time will fail.

**Affected Files:**
- `apps/engine/src/workers/workflow.worker.ts:141-153`
- `apps/engine/src/services/rollback-orchestrator.ts:64`
- `apps/engine/tests/integration/saga.test.ts:77-79` (correctly uses the prefixed key)

---

### Migrations are manual — never auto-run on startup

`apps/engine/src/db/migrate.ts` is a one-shot script: `tsx apps/engine/src/db/migrate.ts`. The engine process must come up against an already-migrated database. Adding migration logic to `index.ts` is a regression.

**Affected Files:**
- `apps/engine/src/db/migrate.ts`
- `apps/engine/src/index.ts`

---

### gRPC server has NO authentication

`grpc.ServerCredentials.createInsecure()` is the bind credential (`apps/engine/src/grpc/server.ts:74`). There is no JWT/API-key check anywhere. The deployment assumption is a trusted private network. Do NOT expose port 50051 publicly. If auth is added in the future, do it as a single interceptor — not per-handler checks.

**Affected Files:**
- `apps/engine/src/grpc/server.ts:67-85`
- `apps/engine/src/grpc/agent.service.ts` (no per-RPC auth checks today)

---

### Redis is leader-election only

There is no generic caching. Adding `redisClient.get / set` for any other purpose requires justification — the codebase is intentionally cache-light. If you find yourself reaching for Redis to "cache something," check whether a missing index would solve it instead.

**Affected Files:**
- `apps/engine/src/services/leaderelector.ts` (the only consumer)
- `apps/engine/src/db/index.ts:17-21` (factory)

---

### Workers must NEVER call repositories directly

The worker thread has no pg `Pool`. It IPCs back to the main thread via `MessagePort` for every DB operation (`STEP_FIND`, `STEP_CREATE_OR_FIND`, `STEP_COMPLETE`, `STEP_FAIL`, `STEP_INCREMENT`). Adding `new Pool()` inside the worker creates an unmanaged pool that no shutdown handler closes.

**Affected Files:**
- `apps/engine/src/workers/workflow.worker.ts:65-122` (`IPCClient`)
- `apps/engine/src/services/workflow-executor.ts:110-147` (`handleWorkerMessage`)

---

### `StepRetryError` is not preserved across worker boundary

Piscina structured-clones the rejection reason, which destroys the `StepRetryError` class identity. The worker translates `StepRetryError` into `{ __stepRetry: true, delay, attempt, originalError: { message, name } }` so the main thread can detect it via `isStepRetry(err)` checking the magic key (`workflow-executor.ts:106-108`). Changing the field name on either side without updating the other breaks all retries silently.

**Affected Files:**
- `apps/engine/src/workers/workflow.worker.ts:196-208` (worker-side marshalling)
- `apps/engine/src/services/workflow-executor.ts:82-86,106-108` (main-side detection)

---

## Common Mistakes

- **Logging without a TAG** — Every module that logs must declare `const TAG = '[module-name]'` and prefix lines as `${TAG} <msg>`. Stray un-tagged `console.log` is project noise.
- **Mocking `pg.Pool.query` in repository tests** — Repository tests are integration tests by design. Use `createTestPool()` from `apps/engine/tests/helpers/db.ts`. The whole point is to verify the SQL.
- **Using `JSON.stringify` for step payloads** — Step inputs/outputs go through `serialize` / `deserialize` from `@duraflow/sdk` (superjson) so `Date`, `Map`, `Set`, `Error` round-trip. Plain `JSON.stringify` silently drops those types.
- **Forgetting `return` after `callback()`** — Every error branch in a gRPC handler must `return callback(...)` to prevent double-invoke. Multiple invocations of the same callback throw inside `@grpc/grpc-js`.
- **Reading `err.message` without an `instanceof Error` guard** — `err` in catch blocks is `unknown`. Always guard, then fall back to `String(err)`.
- **Logging full task `input` / `output` / `error` JSONB** — Customer-controlled. Log `task_id`, `workflow_name`, and byte size. Never the contents.
- **Importing `apps/engine` from inside `packages/sdk`** — The SDK is the boundary. Workflows under `apps/engine/src/workflows/` must also import only from `@duraflow/sdk`, never from engine internals.
- **Generating UUIDs in application code for row PKs** — All table PKs default to `gen_random_uuid()` in DDL. Read back via `RETURNING *`. The only `uuid` use in the engine is `worker-${uuid().slice(0,8)}` for the worker id at startup (`apps/engine/src/index.ts:25`).
- **Calling `dlqRepo.retry()` automatically** — DLQ retries are operator-driven by design. Adding auto-retry is a scope change.

## Performance Landmines

- **Plain `setInterval` in a poll loop** — Use recursive `setTimeout` like `Poller.poll` so each tick waits for the previous one to finish. The exception is `HeartbeatService` and `Reaper`, where intervals are intentionally fixed and short.
- **CPU work on the main thread** — The gRPC server, poller, executor IPC handler, and event-loop monitor all share one event loop. Heavy work belongs in a Piscina step. If `monitor.lag >= MAX_EVENT_LOOP_LAG`, the poller pauses — debug the CPU sink, do not raise the threshold.
- **`SELECT *` on hot paths** — `findPendingTasks` and `findById` return everything, which is fine for now. If you add a hot path that only needs a few columns (e.g., a count or status check), narrow the SELECT.
- **N+1 step fetches in rollback** — `RollbackOrchestrator.rollback` reads all compensatable steps in one query (`findCompletedWithCompensation`). Adding per-step lookups inside the loop would re-introduce N+1.
- **Unbounded admin batches** — Any future DLQ replay / retention purge must chunk with `LIMIT $1 OFFSET $2`. The example in `rules/reliability.md` is canonical.
- **Forgetting `timeout.unref()` on long-lived pending timers** — `IPCClient.send` already calls `timeout.unref()` (`workflow.worker.ts:103`). Without it, the worker process can't exit cleanly.

## Naming Confusion

| Term | Meaning in Engine | Meaning in DB / Proto | Files |
|------|-------------------|----------------------|-------|
| `taskStatus` | TypeScript enum, `camelCase` name + `lowercase string` values: `taskStatus.PENDING = 'pending'` | DB stores the lowercase string; proto `TaskStatus` uses `SCREAMING_SNAKE_CASE` (e.g., `PENDING`, `CANCELLED`). Handler does `task.status.toUpperCase()` when responding. | `apps/engine/src/db/task.entity.ts`, `apps/engine/src/grpc/agent.service.ts:44`, `packages/proto/agent.service.proto:6-13` |
| `step_runs` | TS interface is `StepRunsEntity` (plural-singular mix because column matches table name) | Table is `step_runs`, column status enum is `stepStatus` (`pending/running/completed/failed/cancelled`) | `apps/engine/src/db/step_runs.entity.ts` |
| `workerId` | At startup: `worker-${uuid().slice(0,8)}` for the engine instance. Also stored in `agent_tasks.worker_id` when a task is dequeued. | DB column is `worker_id`. Reaper compares against this to recover stale tasks. | `apps/engine/src/index.ts:25`, `apps/engine/src/repositories/task.repository.ts:64-81` |
| `compensation_fn` | DB column on `step_runs` — stores the compensation **key** (string), not a function reference | The same string is used as the key into the process-local `compensationRegistry` Map | `apps/engine/src/db/step_runs.entity.ts:21`, `packages/sdk/src/compensation.ts` |
| `partial_rollback` vs `rolled_back` | `partial_rollback` = at least one compensation went to DLQ. `rolled_back` = all compensations succeeded. NEVER reuse `failed` for rollback outcomes. | DB values match exactly | `apps/engine/src/db/task.entity.ts:7-8`, `apps/engine/src/services/rollback-orchestrator.ts:118-119` |
| `step.run` | SDK method on `StepRunner` — memoizes by `(task_id, step_key)` and (optionally) registers a compensation | The DB row in `step_runs` is the persisted side of one `step.run` call | `packages/sdk/src/types.ts`, `apps/engine/src/workers/workflow.worker.ts:124-173` |

## Tech Debt & Known Issues

- **Cancellation does not interrupt an in-flight worker** — `CancelTask` sets `agent_tasks.status = 'cancelled'` but cannot send a signal to a running Piscina thread. The worker will run to completion. `WorkflowExecutor.execute()` re-fetches task status after the worker returns and, if cancelled, triggers rollback instead of completing. This means a cancelled task may still consume CPU time in the worker. True mid-execution interruption would require a cancellation token passed into the worker. Files: `apps/engine/src/services/workflow-executor.ts`.
- **`ts-proto` generated types are not used by the engine server** — `packages/proto/generated/agent.service.ts` uses camelCase field names (ts-proto convention) while the engine uses `proto-loader` with `keepCase: true` which preserves `snake_case`. Directly importing the generated types as handler request/response shapes would be misleading. Fixing this properly requires either removing `keepCase: true` from proto-loader (breaking all handlers) or writing manual snake_case interfaces. The current `any` on `call.request` is the documented trade-off. Files: `apps/engine/src/grpc/server.ts`, `packages/proto/generated/`.
- **`apps/dashboard/` is empty** — directory exists, no `package.json`, no sources. Not part of workspaces in practice.
- **No `.prettierrc` despite the root `format` script** — Prettier runs with defaults.
- **Heartbeat default is 5s, reaper threshold is 300s** — `300/5 = 60` heartbeats before reaping. If you tune one, audit the ratio. Files: `apps/engine/src/services/heartbeat.service.ts:9`, `apps/engine/src/index.ts:21`.
- **`HealthService` is wired but its DB/Redis impl is minimal** — verify the `Check` does not introduce a heavy roundtrip; per `rules/coding-style.md`, it should be `SELECT 1` at most. Files: `apps/engine/src/grpc/health.service.ts`.
- **Qdrant is in `docker-compose.yml` but no client lib installed** — planned for future vector search; not part of any code path today. Files: `docker-compose.yml`.

Previously resolved:
- ~~Cancellation does not auto-rollback~~ — Fixed: `cancelTask` now triggers `RollbackOrchestrator` for `RUNNING` tasks. `WorkflowExecutor.execute()` checks for post-execution cancellation and routes to rollback. (`agent.service.ts`, `workflow-executor.ts`)
- ~~`GetStep` / `CompleteStep` / `FailStep` RPCs not wired~~ — All six RPCs are implemented in `agent.service.ts` and bound in `server.ts`.
- ~~No ESLint config~~ — `eslint.config.mjs` at the repo root uses `typescript-eslint` with `no-floating-promises`, `prefer-const`, `no-var`, and test-file relaxations.

## "Why Is It Done This Way?"

- **`taskStatus` enum uses `camelCase` enum name + lowercase string values** — Unusual but consistent across the project (`taskStatus.PENDING = 'pending'`). The lowercase values are what's stored in Postgres; the camelCase enum name is the TS handle. Do NOT switch to PascalCase mid-feature. See `apps/engine/src/db/task.entity.ts`.
- **Recursive `setTimeout` instead of `setInterval` in `Poller.poll`** — Each tick must wait for the previous one to finish. `setInterval` would fire concurrent ticks if the dequeue ever takes longer than the interval, which would let two ticks both try to claim work. See `apps/engine/src/services/poller.ts:54-88`.
- **Worker re-throws `StepRetryError` as a plain object with `__stepRetry: true`** — Piscina structured-clones the rejection across the worker boundary, which destroys `Error` subclass identity. The plain object survives the boundary intact; the main thread checks the magic key. See `apps/engine/src/workers/workflow.worker.ts:196-208`.
- **`RollbackOrchestrator` uses an inline `executeWithTimeout` helper instead of `Promise.race`** — The helper resolves the timeout cleanly and clears the timer in both branches. `Promise.race` leaks the timer when the function resolves first. See `apps/engine/src/services/rollback-orchestrator.ts:134-154`.
- **`LeaderElector.releaseLeadership` uses a Lua script even though `del` is simple** — The script ensures only the current leader can delete the key. Without it, a process that lost leadership could still delete a newer leader's key during shutdown. See `apps/engine/src/services/leaderelector.ts:28-40`.
- **All wiring lives in one `apps/engine/src/index.ts`** — No IoC container, no module decorators. The intent is to keep dependency direction visible at one site. Resist introducing `@Injectable` or a DI library.
- **The handler returns `task.status.toUpperCase()`** — The proto uses `SCREAMING_SNAKE_CASE` enum values; the DB stores lowercase. The handler does the conversion on the way out. See `apps/engine/src/grpc/agent.service.ts:44`.

## Recent Reverts & Hotfixes

Recent git history is dominated by saga / compensation work; there are no `revert:` or explicit `hotfix:` commits in the last 30 commits. The pattern of small, focused commits suggests fixes have been rolled forward, not reverted.

Notable recent commits (`git log --oneline`):
- `b5c945e enginee | API doc and saga edge cases covered` — added integration coverage for compensation failures.
- `a7acb4a Saga workflow: compensation failure and three step booking workflow` — exercised the three-step `booking-saga` to validate LIFO rollback.
- `0482f57 Implemented LIFO rollback` — the actual LIFO ordering implementation.
- `6f4503a Compesation schema changes and added compensation changes to stepOptions` — note: `compensation_fn` column on `step_runs` was added here; the registry key shape (`${workflowName}:${stepKey}`) crystallized in the worker around this time.
- `81e9f73 enginee: Updated repear stale threshold from 330 second to 300 seconds` — heartbeat:reaper ratio is intentional; if you change `REAPER_STALE_THRESHOLD`, audit the heartbeat interval too.
- `bb17250 engine: Added piscina for worker threads utilization and worker-main IPC protocol` — IPC contract crystallized here. Future changes must keep both sides in sync (see DEPENDENCY-MAP.md).
- `52cdcb8 enginee: Handled Backpressure issue, event loop lag detection queue monitoring` — `checkBackpressure` closure in `index.ts` came from here.
- `290b838 sdk: used superJson insted of native json` — payloads now round-trip Date/Map/Set/Error via `superjson`. Do not regress.
