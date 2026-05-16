# End-to-End Flows

These are the system flows that explain *how Duraflow works*. Each step cites the file where the logic lives.

---

## Flow 1: Task Submission

### Trigger
A client invokes `AgentService.SubmitTask({ workflow_name, input })` over gRPC.

### Steps
1. **gRPC server** (`apps/engine/src/grpc/server.ts:50-54`) — routes the RPC to `AgentServiceImpl.submitTask`.
2. **Handler** (`apps/engine/src/grpc/agent.service.ts:16-30`) — validates `workflow_name` is a non-empty string, JSON-parses the `input` bytes, and calls `TaskRepository.create`.
3. **Repository** (`apps/engine/src/repositories/task.repository.ts:7-13`) — `INSERT INTO agent_tasks (workflow_name, input) VALUES($1, $2) RETURNING *`. Postgres generates the UUID and the row defaults `status = 'pending'`.
4. **Handler** — calls `callback(null, { task_id: task.id })`.

### Data Flow
- **Input:** `{ workflow_name: string, input: bytes }` (input is JSON-encoded by the client)
- **Output:** `{ task_id: uuid }`
- **Persisted:** new row in `agent_tasks` with `status = 'pending'`

### Error Handling
- Step 2: empty/missing `workflow_name` → `INVALID_ARGUMENT`.
- Step 3: any DB error → caught in step 2's try/catch → `INTERNAL` with `String(err)`.

### Files Involved
| File | Role |
|------|------|
| `apps/engine/src/grpc/server.ts` | RPC routing |
| `apps/engine/src/grpc/agent.service.ts` | Handler with input validation |
| `apps/engine/src/repositories/task.repository.ts` | `INSERT ... RETURNING *` |

### Related Flows
- The new `pending` row is picked up by **Flow 2: Task Execution** on the next `Poller` tick.

---

## Flow 2: Task Execution (Happy Path)

### Trigger
`Poller.poll()` ticks every 100–500ms (exponential backoff while idle).

### Steps
1. **Backpressure check** (`apps/engine/src/index.ts:69-86`) — `checkBackpressure()` returns true if `executor.queueSize >= MAX_QUEUE_SIZE` OR `monitor.lag >= MAX_EVENT_LOOP_LAG`. If true, `Poller` skips this tick and reschedules in 1 second (`poller.ts:57-63`).
2. **Dequeue** (`apps/engine/src/repositories/task.repository.ts:64-81`) — atomic CTE: `SELECT id ... FOR UPDATE SKIP LOCKED` then `UPDATE` to set `status='running'`, `worker_id`, `heartbeat_at=NOW()`, `RETURNING agent_tasks.*`.
3. **Hand off to runner** (`apps/engine/src/services/poller.ts:72-74`) — fires `onTaskReceived(task)` per task without awaiting (`Promise.catch` for errors). Wired in `index.ts:93` to call `runTask`.
4. **Start heartbeat** (`apps/engine/src/task-runner.ts:13`) — `HeartbeatService.start(taskId)` sets a `setInterval` that updates `agent_tasks.heartbeat_at` every 5s.
5. **Dispatch to worker** (`apps/engine/src/services/workflow-executor.ts:62-95`) — creates a `MessageChannel`, attaches a message listener on `port1` (the IPC reply handler), and calls `piscina.pool.run({ taskId, workflowName, input, port: port2 }, { transferList: [port2] })`.
6. **Worker execution** (`apps/engine/src/workers/workflow.worker.ts:175-212`) — `executeWorkflow`:
   a. Looks up the workflow in `globalRegistry` by name. If not found, throws.
   b. Builds a `StepRunner` whose `run(name, fn, opts)` IPCs back to the main thread for each step (`STEP_FIND` → `STEP_CREATE_OR_FIND` → execute `fn` → `STEP_COMPLETE`). Caches: if `STEP_FIND` returns `{ status: 'completed' }`, returns the cached `output` without re-executing.
   c. Registers any `compensation` under the key `${workflowName}:${stepKey}` in `compensationRegistry`.
   d. Returns the workflow handler's result.
7. **Persist completion** (`apps/engine/src/services/workflow-executor.ts:78`) — `taskRepo.updateCompleted(task.id, result)` sets `status='completed'`, `output=$result`, `completed_at=NOW()`.
8. **Stop heartbeat** (`apps/engine/src/task-runner.ts:23`) — `finally { heartbeat.stop(taskId) }` clears the interval.

### Data Flow
- **Input:** `agent_tasks.input` (JSONB) — passed through Piscina structured clone to the worker.
- **Output:** workflow return value — written to `agent_tasks.output` and any step output is written to `step_runs.output`.
- **Persisted:** `agent_tasks.status` transitions `pending → running → completed`. `step_runs` rows created/updated per step.

### Error Handling
- Step 1: backpressure → skip tick.
- Step 2: dequeue throws → log `[poller] dequeue error`, set interval to `maxInterval` (500ms), continue.
- Step 5–7: worker rejects with `__stepRetry` → `Flow 3`. Worker rejects with any other error → `taskRepo.fail` (status=`failed`) → if compensations exist, **Flow 4** runs separately (currently rollback is invoked from tests; the engine's automatic-rollback wiring is in `WorkflowExecutor.execute`'s catch via the orchestrator — verify via integration tests).
- Step 8 always runs in `finally`, even on retry/failure.

### Files Involved
| File | Role |
|------|------|
| `apps/engine/src/services/poller.ts` | Dequeue loop + backoff |
| `apps/engine/src/repositories/task.repository.ts` | `dequeue` SQL with SKIP LOCKED |
| `apps/engine/src/task-runner.ts` | Orchestrates heartbeat + executor |
| `apps/engine/src/services/heartbeat.service.ts` | Per-task setInterval |
| `apps/engine/src/services/workflow-executor.ts` | Piscina dispatch + IPC reply handler |
| `apps/engine/src/workers/workflow.worker.ts` | Worker entry, `IPCClient`, `StepRunner`, `executeWorkflow` |

### Related Flows
- Failure path → **Flow 3 (retry)** or **Flow 4 (saga rollback)**.
- Stale `running` task → **Flow 5 (reaper)**.

---

## Flow 3: Step Retry

### Trigger
A step throws inside `step.run(name, fn, { retries: N })` and `currentAttempt <= N`.

### Steps
1. **StepRunner catches the throw** (`apps/engine/src/workers/workflow.worker.ts:155-163`) — increments the step's `attempt` via IPC (`STEP_INCREMENT`), computes `delay = calculateBackOff(currentAttempt)`, and throws `StepRetryError(delay, currentAttempt + 1, err)`.
2. **Worker re-throws as plain object** (`workflow.worker.ts:196-208`) — Piscina cannot structured-clone an `Error` subclass cleanly, so the worker translates `StepRetryError` into `{ __stepRetry: true, delay, attempt, originalError: { message, name } }`.
3. **Main thread detects retry** (`apps/engine/src/services/workflow-executor.ts:82-86`) — `isStepRetry(err)` checks for `__stepRetry`. If true, calls `taskRepo.scheduleRetry(task.id, err.delay, err.attempt, err.originalError)`.
4. **Schedule retry in DB** (`apps/engine/src/repositories/task.repository.ts:83-105`) — sets `status='pending'`, `scheduled_at = NOW() + ($delay || ' milliseconds')::INTERVAL`, `retry_count = $attempt`, persists `error` JSONB, clears `worker_id` and `heartbeat_at`.
5. **Next Poller tick** — when `scheduled_at <= NOW()`, the task is dequeued again (Flow 2 from step 2).

### Data Flow
- **Persisted:** `agent_tasks.status = 'pending'`, `agent_tasks.scheduled_at` set into the future, `agent_tasks.error` snapshot of the latest failure, `agent_tasks.retry_count` incremented.

### Error Handling
- If the step throws and `currentAttempt > maxRetries`: the worker marks the step `failed` via `STEP_FAIL` and re-throws the original error. The main thread's catch falls through to `taskRepo.fail(task.id, err)` — `agent_tasks.status = 'failed'`. Saga compensations (if any) trigger Flow 4.

### Files Involved
| File | Role |
|------|------|
| `apps/engine/src/workers/workflow.worker.ts` | `StepRunner.run` retry branch + StepRetryError marshalling |
| `apps/engine/src/errors/step-retry.error.ts` | Error class with `delay`, `attempt`, `originalError` |
| `apps/engine/src/utils/backoff.ts` | `calculateBackOff(attempt)` exponential backoff |
| `apps/engine/src/services/workflow-executor.ts` | Main-thread detection + schedule call |
| `apps/engine/src/repositories/task.repository.ts` | `scheduleRetry` SQL |

---

## Flow 4: Saga Rollback (LIFO Compensation)

### Trigger
A task transitions to `failed` (or is `cancelled`) AND has one or more `step_runs` rows with `status='completed'` and `compensation_fn IS NOT NULL`.

### Steps
1. **Fetch compensatable steps** (`apps/engine/src/services/rollback-orchestrator.ts:43`) — `StepRepository.findCompletedWithCompensation(taskId)` returns completed steps with `compensation_fn` set, ordered for LIFO traversal.
2. **For each step, look up compensation by name** (`rollback-orchestrator.ts:64-65`) — `compensationRegistry.get(fnName)`. The key was set by the worker as `${workflowName}:${stepKey}` (e.g., `booking-saga:book-flight`).
3. **If not registered**: insert into `dead_letter_queue` with `error: "Compensation function ... not found"`, increment `failed`, continue.
4. **Execute compensation with 30s timeout** (`rollback-orchestrator.ts:86-115, 134-154`) — `executeWithTimeout(fn, step.output, timeoutMs)`. On success: `stepRepo.markCompensated(step.id)` (sets `compensated_at`). On timeout or throw: insert into `dead_letter_queue` with full error context, increment `failed`.
5. **Persist terminal status** (`rollback-orchestrator.ts:118-120`) — `agent_tasks.status = 'rolled_back'` if all succeeded, `'partial_rollback'` if any failed.

### Data Flow
- **Input:** `taskId`, default 30s per-compensation timeout (configurable).
- **Output:** `RollbackResult { taskId, totalSteps, compensated, failed, finalStatus }`.
- **Persisted:** `step_runs.compensated_at` for successful compensations; `dead_letter_queue` rows for failures; `agent_tasks.status` set to `rolled_back` or `partial_rollback`.

### Error Handling
- A failed compensation NEVER aborts the rollback. The orchestrator catches and continues so the remaining (later) compensations still run.
- A timeout is reported as `TimeoutError` with message `"Compensation timed out after ${timeoutMs}ms"`.

### Files Involved
| File | Role |
|------|------|
| `apps/engine/src/services/rollback-orchestrator.ts` | LIFO loop, registry lookup, DLQ writes |
| `apps/engine/src/repositories/step.repository.ts` | `findCompletedWithCompensation`, `markCompensated` |
| `apps/engine/src/repositories/dlq.repository.ts` | `insert(taskId, stepId, errorContext)` |
| `apps/engine/src/repositories/task.repository.ts` | `updateStatus` to terminal state |
| `packages/sdk/src/compensation.ts` | `compensationRegistry` (`Map<string, Fn>`) |

### Related Flows
- DLQ entries can be replayed by an operator calling `dlqRepo.retry(id)` — there is no automatic retry.

---

## Flow 5: Stale Task Recovery (Reaper)

### Trigger
`Reaper` ticks every 10s (configurable via `REAPER_INTERVAL`).

### Steps
1. **Leader check at startup** (`apps/engine/src/services/reaper.ts:36-46`) — on `Reaper.start()`, calls `LeaderElector.tryBecomeLeader()`. Only the elected instance proceeds.
2. **Concurrency guard** (`reaper.ts:71-72`) — `if (this.isReaping) return [];` — never overlap two reap cycles on the same instance.
3. **Re-queue stale running tasks** (`reaper.ts:92-104`) — `UPDATE agent_tasks SET status='pending', worker_id=NULL, retry_count = retry_count + 1 WHERE status='running' AND heartbeat_at < NOW() - INTERVAL '$3 seconds' AND retry_count < max_retries RETURNING id, workflow_name, retry_count`.
4. **Fail exhausted tasks** (`reaper.ts:106-121`) — `UPDATE agent_tasks SET status='failed', error=jsonb_build_object('message', 'Task exceeded max retries after worker failure', 'code', 'MAX_RETRIES_EXCEEDED') WHERE status='running' AND heartbeat_at < NOW() - INTERVAL '$3 seconds' AND retry_count >= max_retries RETURNING id, ...`.
5. **Lease renewal** (`leaderelector.ts:47-60`) — runs every `LEADER_TTL_SECONDS / 2` seconds via a Lua script that `EXPIRE`s the lease only if the value still matches this worker's id. If renewal fails, log `[leader] lost leadership` and stop renewing.

### Data Flow
- **Persisted:** `agent_tasks.status` flips `running → pending` (re-queue) or `running → failed` (exhausted).

### Error Handling
- Postgres error during reap → `console.error('[reaper] error during reap cycle', err)`, `isReaping=false`, continue on next tick.
- Redis failure during election → `tryBecomeLeader` throws or returns falsy; reaper does not start on that instance.

### Files Involved
| File | Role |
|------|------|
| `apps/engine/src/services/reaper.ts` | Reap loop + SQL |
| `apps/engine/src/services/leaderelector.ts` | SET NX EX + Lua EXPIRE renew |

### Related Flows
- Re-queued tasks become candidates for **Flow 2** again.
- Tasks failed due to `MAX_RETRIES_EXCEEDED` may trigger **Flow 4** if they had completed steps with compensations.

---

## Flow 6: Cancellation

### Trigger
A client invokes `AgentService.CancelTask({ task_id })`.

### Steps
1. **Handler** (`apps/engine/src/grpc/agent.service.ts:54-78`) — validates `task_id`, calls `taskRepo.findById`. If not found → `NOT_FOUND`. If status is not `pending` or `running` → `FAILED_PRECONDITION` with message `Cannot cancel task with status: ${task.status}`.
2. **Update status** (`task.repository.ts:23-28`) — `UPDATE agent_tasks SET status='cancelled' WHERE id=$1`.
3. **Worker continues** — there is no in-flight cancellation signal sent to the worker today. If the task is `running`, the worker continues until completion; only the row's status reflects the cancellation. Subsequent compensation must be triggered manually (current engine code does not auto-rollback on cancel).

### Data Flow
- **Persisted:** `agent_tasks.status = 'cancelled'`.

### Error Handling
- Race with the executor: if the executor's `updateCompleted` runs after the cancel `updateStatus`, the task may end up `completed` despite the cancel call. The handler succeeds, but the terminal state may not be `cancelled`. **This is a known limitation** — see GOTCHAS.md.

### Files Involved
| File | Role |
|------|------|
| `apps/engine/src/grpc/agent.service.ts` | Validates status preconditions |
| `apps/engine/src/repositories/task.repository.ts` | `updateStatus` |

---

## Flow 7: Engine Startup

### Trigger
`tsx src/index.ts` (or `node dist/index.js`).

### Steps
1. **Load env** (`apps/engine/src/index.ts:1`) — `dotenv/config` import.
2. **Build config** (`index.ts:19-26`) — read `PORT`, `REAPER_*`, `MAX_QUEUE_SIZE`, `MAX_EVENT_LOOP_LAG`; generate `workerId = 'worker-' + uuid.v7().slice(0,8)`.
3. **Create singletons** (`index.ts:29-37`) — `createPool()`, `createRedis()`, `createPiscinaPool()`, then `TaskRepository`, `HeartbeatService`, `WorkflowExecutor`. **No IoC container — order matters.**
4. **Health checks** (`index.ts:53-57`) — `pool.query('SELECT 1')` and `redis.ping()` before binding gRPC. If either fails, the process exits via the top-level `.catch`.
5. **Start gRPC** (`index.ts:60-61`) — `createGrpcServer(pool, redis)` then `startGrpcServer(server, port)` binds `0.0.0.0:$port` with insecure credentials.
6. **Start reaper** (`index.ts:64-65`) — `new Reaper(...).start()`. If this instance is not the leader, the reaper logs and does nothing (other instance does the work).
7. **Start backpressure monitor + poller** (`index.ts:68-95`) — `EventLoopMonitor`, `checkBackpressure` closure, `Poller(taskRepo, { workerId, batchSize, checkBackpressure, onTaskReceived })`, `poller.start()`.
8. **Register shutdown** (`index.ts:114-116`) — `SIGTERM`, `SIGINT`, `SIGUSR2` → `shutdown(signal)` which calls `heartbeat.stopAll()`, `poller.stop()`, `reaper.stop()`, `executor.destroy()`, `pool.end()`, `redis.quit()` then `process.exit(0)`.

### Data Flow
- **Input:** environment variables.
- **Output:** running gRPC server on port 50051 (default), Poller + Reaper loops active.

### Error Handling
- Top-level `main().catch` (`index.ts:118-121`) — logs `[duraflow] fatal` and `process.exit(1)`.
- `pool.on('error', ...)` (`index.ts:33`) — logs idle client errors without crashing.

### Files Involved
| File | Role |
|------|------|
| `apps/engine/src/index.ts` | The entire wiring + lifecycle |
| `apps/engine/src/db/index.ts` | Pool + Redis factories |
| `apps/engine/src/grpc/server.ts` | gRPC bootstrap |
| `apps/engine/src/services/index.ts` | Service barrel + `createPiscinaPool` |
