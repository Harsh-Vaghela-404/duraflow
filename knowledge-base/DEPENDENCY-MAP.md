# Dependency Map

## Module Dependencies

| Module | Depends On | Depended On By |
|--------|-----------|----------------|
| `apps/engine/src/index.ts` | `db`, `grpc/server`, `repositories/task`, `services/*`, `task-runner`, `uuid`, `dotenv` | — (process entry) |
| `apps/engine/src/task-runner.ts` | `db/task.entity`, `services/workflow-executor`, `services/heartbeat.service` | `index.ts` |
| `apps/engine/src/grpc/server.ts` | `@grpc/grpc-js`, `@grpc/proto-loader`, `@grpc/reflection`, `grpc/health.service`, `grpc/agent.service` | `index.ts` |
| `apps/engine/src/grpc/agent.service.ts` | `@grpc/grpc-js`, `pg`, `repositories/task.repository`, `db/task.entity` | `grpc/server` |
| `apps/engine/src/grpc/health.service.ts` | `pg`, `ioredis` | `grpc/server` |
| `apps/engine/src/services/poller.ts` | `repositories/task.repository`, `db/task.entity` | `index.ts` |
| `apps/engine/src/services/heartbeat.service.ts` | `repositories/task.repository` | `index.ts`, `task-runner.ts` |
| `apps/engine/src/services/reaper.ts` | `pg`, `ioredis`, `db/task.entity`, `services/leader-elector` | `index.ts` |
| `apps/engine/src/services/leader-elector.ts` | `ioredis` | `services/reaper` |
| `apps/engine/src/services/rollback-orchestrator.ts` | `pg`, `@duraflow/sdk` (`compensationRegistry`), `repositories/{step,task,dlq}.repository`, `db/task.entity` | `services/workflow-executor` (indirect, see Gotchas) |
| `apps/engine/src/services/workflow-executor.ts` | `pg`, `piscina`, `worker_threads`, `repositories/{step,task}.repository`, `db/task.entity` | `index.ts`, `task-runner.ts` |
| `apps/engine/src/services/event-loop-monitor.ts` | — (`perf_hooks`) | `index.ts` |
| `apps/engine/src/services/index.ts` | re-exports all `services/*` + `createPiscinaPool` | `index.ts` |
| `apps/engine/src/repositories/task.repository.ts` | `pg`, `db/task.entity` | `grpc/agent.service`, `services/{poller,heartbeat,reaper,workflow-executor,rollback-orchestrator}`, `index.ts` |
| `apps/engine/src/repositories/step.repository.ts` | `pg`, `db/step_runs.entity` | `services/workflow-executor`, `services/rollback-orchestrator` |
| `apps/engine/src/repositories/dlq.repository.ts` | `pg`, `db/dead_letter_queue.entity` | `services/rollback-orchestrator` |
| `apps/engine/src/db/index.ts` | `pg`, `ioredis`, `dotenv/config` | `index.ts`, all repositories indirectly |
| `apps/engine/src/db/migrate.ts` | `pg` | run manually via `tsx`; not part of the engine process |
| `apps/engine/src/workers/step-worker.ts` | `worker_threads`, `crypto`, `path`, `@duraflow/sdk`, `errors/step-retry.error`, `utils/backoff` | Piscina (loaded by `createPiscinaPool` filename arg) |
| `apps/engine/src/workflows/booking-saga.ts` | `@duraflow/sdk` only | loaded at worker boot via `DURAFLOW_WORKFLOWS` |
| `apps/engine/src/workflows.ts` | re-exports workflows | loaded at worker boot via `DURAFLOW_WORKFLOWS` |
| `apps/engine/src/errors/step-retry.error.ts` | — | `workers/step-worker` |
| `apps/engine/src/utils/backoff.ts` | — | `workers/step-worker` |
| `packages/sdk/src/workflow.ts` | `./types` | `packages/sdk/src/index.ts` |
| `packages/sdk/src/compensation.ts` | — | `packages/sdk/src/index.ts`, `services/rollback-orchestrator`, `workers/step-worker`, integration tests |
| `packages/sdk/src/utils/serialization.ts` | `superjson` | `packages/sdk/src/index.ts`, `workers/step-worker` |
| `packages/sdk/src/types.ts` | — | `workflow.ts`, `workers/step-worker` |

**Boundary rule (enforced by convention):** `packages/sdk` MUST NEVER import from `apps/engine`. Files under `apps/engine/src/workflows/` MUST import only from `@duraflow/sdk`, never from engine internals.

## Service-to-Table Map

| Service | Tables Written | Tables Read |
|---------|---------------|-------------|
| `grpc/agent.service.ts` (`AgentServiceImpl.submitTask`) | `agent_tasks` (INSERT via `TaskRepository.create`) | — |
| `grpc/agent.service.ts` (`AgentServiceImpl.getTaskStatus`) | — | `agent_tasks` (`TaskRepository.findById`) |
| `grpc/agent.service.ts` (`AgentServiceImpl.cancelTask`) | `agent_tasks` (UPDATE status) | `agent_tasks` |
| `services/poller.ts` | `agent_tasks` (UPDATE → `running`) | `agent_tasks` (via `dequeue` CTE) |
| `services/heartbeat.service.ts` | `agent_tasks` (`heartbeat_at`) | — |
| `services/reaper.ts` | `agent_tasks` (UPDATE → `pending` or `failed`) | `agent_tasks` |
| `services/workflow-executor.ts` (main thread IPC handler) | `step_runs` (`createOrFind`, `updateCompleted`, `updateFailed`, `incrementAttempt`) | `step_runs` (`findByTaskAndKey`) |
| `services/workflow-executor.ts` (`execute`) | `agent_tasks` (`updateCompleted`, `scheduleRetry`, `fail`) | — |
| `services/rollback-orchestrator.ts` | `step_runs` (`markCompensated`), `agent_tasks` (`updateStatus` → `rolled_back` / `partial_rollback`), `dead_letter_queue` (INSERT) | `step_runs` (`findCompletedWithCompensation`) |
| `db/migrate.ts` | `agent_tasks`, `step_runs`, `dead_letter_queue` (DDL) | — |

## External Integration Map

| External Service | Client File | Used By | Failure Impact |
|-----------------|-------------|---------|----------------|
| PostgreSQL | `apps/engine/src/db/index.ts:8-15` (`createPool`) | every service and repository | Total halt — gRPC handlers return `INTERNAL`; poller backs off; reaper skips. Tasks remain in their current state. |
| Redis | `apps/engine/src/db/index.ts:17-21` (`createRedis`) | `services/leader-elector.ts` (and via `Reaper`) | Reaper does not run this tick. No effect on gRPC or task execution. On next leader cycle, stale tasks are picked up. |
| Piscina worker pool | `apps/engine/src/services/workflow-executor.ts:32-49` | `services/workflow-executor.ts` (main thread) | If `pool.run` rejects: task is failed and (if compensations exist) rolled back. IPC timeout (30s) per step request from worker. |
| Qdrant | not wired | — | N/A (provisioned in docker-compose, no client lib installed) |

## Event / Message Map

There is no message bus or queue beyond Postgres itself. The only IPC channels are:

| Channel | Producer | Consumer | Payload |
|---------|----------|----------|---------|
| Piscina `pool.run({ taskId, workflowName, input, port })` | `WorkflowExecutor.execute` (main) | `step-worker.ts` module exports | `WorkerTask` interface |
| `MessagePort` request (`port1.on('message')`) | `IPCClient.send` (worker) | `WorkflowExecutor.handleWorkerMessage` (main) | `IPCRequest` ({ id, type: `STEP_FIND` \| `STEP_CREATE_OR_FIND` \| `STEP_COMPLETE` \| `STEP_FAIL` \| `STEP_INCREMENT`, payload }) |
| `MessagePort` response (`port.on('message')`) | `WorkflowExecutor.handleWorkerMessage` (main) | `IPCClient.handleResponse` (worker) | `IPCResponse` ({ id, success, data?, error? }) |
| Worker thrown `{ __stepRetry, delay, attempt, originalError }` | `step-worker.ts` (after `StepRetryError`) | `WorkflowExecutor.execute` catch block | structured-cloned object, NOT an `Error` instance |
| `taskRepo.scheduleRetry` write | `WorkflowExecutor.execute` | next `Poller.poll` cycle (via `agent_tasks.status = 'pending'` + `scheduled_at`) | — |
| `dead_letter_queue` INSERT | `RollbackOrchestrator.rollback` | operator manual `dlqRepo.retry(id)` | — |

## Shared Module Usage

| Shared Module | Used By | Notes |
|--------------|---------|-------|
| `@duraflow/sdk` (workspace) | `apps/engine/src/workers/step-worker.ts`, `apps/engine/src/services/rollback-orchestrator.ts`, `apps/engine/src/workflows/booking-saga.ts`, integration tests | Workflow author surface. Engine internals access `compensationRegistry`. |
| `@duraflow/proto` (workspace) | not yet imported by engine — proto files loaded by `@grpc/proto-loader` at runtime | `packages/proto/generated/*.ts` exist but the engine still does `protoLoader.loadSync` against raw `.proto`. |
| `apps/engine/tests/helpers/db.ts` | every integration and e2e test | `createTestPool`, `createTestRedis`, `closePool`, `clearTables`, `createTask` |
| `apps/engine/tests/helpers/poll.ts` | e2e tests, some integration tests | helpers for polling task status until terminal |

## Blast Radius

### Modifying `task.repository.ts`
Touches: every service except `LeaderElector` and `EventLoopMonitor`. Always re-run the unit tests for `Poller`, `Reaper`, `Heartbeat` AND the integration tests (`crash-recovery`, `dequeue-concurrent`, `saga`, `workflow-executor`).

### Modifying `agent_tasks` schema
Migration is `apps/engine/src/db/migrate.ts`. Every JSONB or column change must be reflected in `db/task.entity.ts` (interface + enum). Verify `TaskRepository.dequeue`, `Reaper.requeueStaleTasks`, and `RollbackOrchestrator.rollback`'s `updateStatus` calls still match the new schema.

### Modifying gRPC proto
`packages/proto/agent.service.proto` is loaded at runtime in `grpc/server.ts`. Changing field names will silently break clients. Bump versions instead of renaming. The generated `packages/proto/generated/*.ts` is NOT loaded by the engine; do not rely on it for type safety in the engine.

### Modifying `compensationRegistry`
Process-local Map. Tests must register compensations they reference (`registerCompensation('booking-saga:book-flight', fn)`). Renaming a registry key is a breaking change for everyone using that workflow.

### Modifying `step-worker.ts` IPC
Both the main thread (`WorkflowExecutor.handleWorkerMessage`) and the worker (`IPCClient`) must change in lockstep. `IPCMessageType` is duplicated in both files — TypeScript will not catch a divergence.
