# Code Patterns

> Each pattern below is real code from the project (file paths in the first comment line).
> Where the codebase has a clear anti-pattern to avoid, it is called out inline.

## TAG Logging (Mandatory)

Every module declares a TAG constant at the top and prefixes every log line with it. There is no structured logger — `console.log/warn/error` is the project's logger, and the TAG is what makes the output greppable.

```typescript
// Source: apps/engine/src/services/heartbeat.service.ts
import { TaskRepository } from '../repositories/task.repository';

const TAG = '[heartbeat]';

export class HeartbeatService {
    private readonly intervalMs: number;
    private intervals = new Map<string, NodeJS.Timeout>();

    constructor(private readonly taskRepo: TaskRepository, intervalMs = 5000) {
        this.intervalMs = intervalMs;
    }

    start(taskId: string): void {
        if (this.intervals.has(taskId)) return;
        const handle = setInterval(async () => {
            try {
                await this.taskRepo.updateHeartbeat(taskId);
            } catch (err) {
                console.error(`${TAG} failed to update heartbeat for task ${taskId}:`, err);
            }
        }, this.intervalMs);
        this.intervals.set(taskId, handle);
        console.log(`${TAG} started for task ${taskId}`);
    }
}
```

Existing TAGs: `[duraflow]`, `[engine]`, `[grpc]`, `[poller]`, `[heartbeat]`, `[reaper]`, `[leader]`, `[rollback]`, `[executor]`, `[worker]`. Reuse the existing TAG when extending a module; pick a new one only for a new file.

**Anti-pattern — do NOT do this:**

```typescript
// Stray, untagged logs are noise. Code review will flag this.
console.log('processing task', task.id);
```

## gRPC Handler

Callback-style, with input validation up front and a try/catch that maps to `grpc.status.X`. The handler never returns a Promise and never throws.

```typescript
// Source: apps/engine/src/grpc/agent.service.ts
import * as grpc from '@grpc/grpc-js';
import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { Pool } from 'pg';
import { TaskRepository } from '../repositories/task.repository';
import { taskStatus } from '../db/task.entity';

const TAG = '[grpc]';

export class AgentServiceImpl {
    private taskRepo: TaskRepository;

    constructor(pool: Pool) {
        this.taskRepo = new TaskRepository(pool);
    }

    async cancelTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id } = call.request;
            if (!task_id || typeof task_id !== 'string') {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'task_id is required' });
            }
            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });
            if (task.status !== taskStatus.PENDING && task.status !== taskStatus.RUNNING) {
                return callback({
                    code: grpc.status.FAILED_PRECONDITION,
                    message: `Cannot cancel task with status: ${task.status}`,
                });
            }
            await this.taskRepo.updateStatus(task_id, taskStatus.CANCELLED);
            callback(null, { success: true });
        } catch (err) {
            console.error(`${TAG} cancelTask error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }
}
```

## Raw `pg` Repository (No ORM)

One class per table. Constructor takes the `Pool`. Every query is `pool.query(SQL, [params])` with `$1..$N` placeholders.

```typescript
// Source: apps/engine/src/repositories/task.repository.ts
import { Pool } from "pg";
import { TaskEntity, taskStatus } from "../db/task.entity";

export class TaskRepository {
  constructor(private readonly pool: Pool) {}

  async create(name: string, input: Record<string, any>): Promise<TaskEntity> {
    const res = await this.pool.query(
      "INSERT INTO agent_tasks (workflow_name, input) VALUES($1, $2) RETURNING *",
      [name, input],
    );
    return res.rows[0];
  }

  async findById(id: string): Promise<TaskEntity | null> {
    const res = await this.pool.query("SELECT * FROM agent_tasks WHERE id = $1", [id]);
    return res.rows[0] || null;
  }

  async fail(id: string, error: unknown): Promise<void> {
    const errorObj = error instanceof Error
      ? { message: error.message, name: error.name, stack: error.stack }
      : { message: String(error) };
    await this.pool.query(
      "UPDATE agent_tasks SET status = $1, error = $2, completed_at = NOW() WHERE id = $3",
      [taskStatus.FAILED, JSON.stringify(errorObj), id],
    );
  }
}
```

## `FOR UPDATE SKIP LOCKED` Dequeue

The project's queue primitive. Every "worker pulls work" pattern MUST use this idiom — never plain `SELECT ... LIMIT N`.

```typescript
// Source: apps/engine/src/repositories/task.repository.ts:64-81
async dequeue(batchSize: number, workerId: string): Promise<TaskEntity[]> {
  const res = await this.pool.query(
    `WITH next_jobs AS (
              SELECT id FROM agent_tasks
              WHERE status = $1 AND (scheduled_at <= NOW() OR scheduled_at IS NULL)
              ORDER BY priority DESC, created_at ASC
              LIMIT $2
              FOR UPDATE SKIP LOCKED
          )
          UPDATE agent_tasks
          SET status = $3, worker_id = $4, heartbeat_at = NOW()
          FROM next_jobs
          WHERE agent_tasks.id = next_jobs.id
          RETURNING agent_tasks.*`,
    [taskStatus.PENDING, batchSize, taskStatus.RUNNING, workerId],
  );
  return res.rows;
}
```

## Background Loop — Recursive `setTimeout`

Background loops use recursive `setTimeout` (NOT `setInterval`) so each tick waits for the previous one to finish. This gives natural backpressure.

```typescript
// Source: apps/engine/src/services/poller.ts (excerpt)
const TAG = '[poller]';

export class Poller {
    private interval = 100;
    private readonly minInterval = 100;
    private readonly maxInterval = 500;
    private running = false;
    private currentTimeout: NodeJS.Timeout | null = null;

    private async poll(): Promise<void> {
        if (!this.running) return;
        if (this.checkBackpressure && this.checkBackpressure()) {
            if (this.running) this.currentTimeout = setTimeout(() => this.poll(), 1000);
            return;
        }
        try {
            const tasks = await this.taskRepo.dequeue(this.batchSize, this.workerId);
            if (tasks.length > 0) {
                this.interval = this.minInterval;
                for (const task of tasks) {
                    if (!this.running) break;
                    this.onTaskReceived(task).catch(err =>
                        console.error(`${TAG} task ${task.id} callback error:`, err));
                }
            } else {
                this.interval = Math.min(this.interval * 2, this.maxInterval);
            }
        } catch (err) {
            console.error(`${TAG} dequeue error:`, err);
            this.interval = this.maxInterval;
        }
        if (this.running) this.currentTimeout = setTimeout(() => this.poll(), this.interval);
    }
}
```

## Manual Dependency Injection

There is **no IoC container, no `@Injectable`, no decorators**. All wiring lives in one file (`apps/engine/src/index.ts`). Services receive their dependencies via constructor, marked `private readonly`.

```typescript
// Source: apps/engine/src/index.ts (excerpt)
const pool = createPool();
const redis = createRedis();
const piscina = createPiscinaPool();

const taskRepo = new TaskRepository(pool);
const heartbeat = new HeartbeatService(taskRepo);
const executor = new WorkflowExecutor(pool, piscina);

const reaper = new Reaper(pool, redis, config.reaperStale, config.reaperInterval);
await reaper.start();

const poller = new Poller(taskRepo, {
    workerId: config.workerId,
    batchSize: 10,
    checkBackpressure,
    onTaskReceived: (task) => runTask(executor, heartbeat, task),
});
poller.start();
```

## Saga Compensation — LIFO with DLQ Fallback

`RollbackOrchestrator.rollback` reads completed steps with `compensation_fn` set, looks each one up in `compensationRegistry` by name, and runs them in **LIFO order**. Failed compensations do NOT abort the rollback — they go to `dead_letter_queue` and the loop continues. The terminal task status is `rolled_back` (all succeeded) or `partial_rollback` (some failed).

```typescript
// Source: apps/engine/src/services/rollback-orchestrator.ts (excerpt)
const TAG = '[rollback]';

for (const step of steps) {
  const fnName = step.compensation_fn!;
  const fn = compensationRegistry.get(fnName);
  if (!fn) {
    await this.dlqRepo.insert(taskId, step.id, {
      taskId, stepId: step.id, stepKey: step.step_key, compensationFn: fnName,
      error: { message: `Compensation function "${fnName}" not found in registry` },
    });
    failed++;
    continue;
  }
  try {
    await this.executeWithTimeout(fn, step.output, timeoutMs);
    await this.stepRepo.markCompensated(step.id);
    compensated++;
  } catch (err) {
    await this.dlqRepo.insert(taskId, step.id, { /* error context */ });
    failed++;
  }
}
const finalStatus = failed > 0 ? taskStatus.PARTIAL_ROLLBACK : taskStatus.ROLLED_BACK;
await this.taskRepo.updateStatus(taskId, finalStatus);
```

The `steps` array is already ordered for LIFO — `findCompletedWithCompensation` returns them in reverse completion order.

## SDK Workflow Definition

User workflows import only from `@duraflow/sdk` — never from engine internals. Each `step.run(name, fn, opts)` declares a step. Compensations are declared **separately**, in the `compensations` map on `workflow(name, handler, { compensations })`, keyed by step key — they must be **pure functions of the step's saved output** (a compensation may be run by a different process than the one that executed the step). The registry key is `${workflowName}:${stepKey}`.

```typescript
// Source: apps/engine/tests/workflows/booking-saga.ts (excerpt)
import { workflow } from "@duraflow/sdk";

export const bookingWorkflow = workflow(
  "booking-saga",
  async ({ step, input }) => {
    const inp = input as BookingInput;

    const flight = await step.run("book-flight", async () => {
      const bookingId = `FLIGHT-${Date.now()}`;
      mockBookings.flights.set(inp.customerId, { bookingId, cancelled: false });
      return { bookingId, ...inp.flightDetails };
    });
    // ... more steps, then a failing charge-payment
    return { flightBookingId: flight.bookingId /* ... */ };
  },
  {
    // Pure functions of each step's saved output. Registered at module load
    // under `booking-saga:<stepKey>`, resolvable in the main (rollback) thread.
    compensations: {
      "book-flight": async (output) => {
        cancelByBookingId(mockBookings.flights, (output as { bookingId: string }).bookingId);
      },
      // "book-hotel": ..., "book-car": ...
    },
  },
);
```

## Piscina Worker IPC (Main ↔ Worker)

The main thread creates a `MessageChannel`, passes `port2` to the worker via `transferList`, and listens on `port1`. The worker wraps its `port` in an `IPCClient` that:
- Generates a UUID per request, sets a 30s `setTimeout` (unref'd so it doesn't keep the process alive), stores the resolver in a `Map`.
- Receives responses keyed by the same UUID and resolves the pending promise.

```typescript
// Source: apps/engine/src/services/workflow-executor.ts:65-94 (main thread)
async execute(task: TaskEntity): Promise<unknown> {
  const { port1, port2 } = new MessageChannel();
  port1.on('message', async (req: IPCRequest) => {
    const res = await this.handleWorkerMessage(req);
    port1.postMessage(res);
  });
  try {
    const result = await this.pool.run(
      { taskId: task.id, workflowName: task.workflow_name, input: task.input, port: port2 },
      { transferList: [port2] },
    );
    await this.taskRepo.updateCompleted(task.id, result);
    return result;
  } catch (err: unknown) {
    if (this.isStepRetry(err)) {
      await this.taskRepo.scheduleRetry(task.id, err.delay, err.attempt, err.originalError);
      return;
    }
    await this.taskRepo.fail(task.id, err);
    throw err;
  } finally {
    port1.removeAllListeners();
    port1.close();
  }
}
```

```typescript
// Source: apps/engine/src/workers/step-worker.ts:65-122 (worker thread IPCClient)
class IPCClient {
  private pending = new Map<string, { resolve, reject, timeout: NodeJS.Timeout }>();
  constructor(private port: MessagePort) {
    this.port.on('message', (msg: IPCResponse) => this.handleResponse(msg));
  }
  send<T>(type: IPCMessageType, payload: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC ${type} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      timeout.unref();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
      this.port.postMessage({ id, type, payload });
    });
  }
}
```

## Step Retry via `StepRetryError`

The worker throws `StepRetryError` from inside `step.run` when `attempt <= retries`. The worker then re-throws it as a plain object with `__stepRetry: true` so it survives Piscina's structured-clone boundary. The `WorkflowExecutor` detects this object and calls `taskRepo.scheduleRetry` instead of `fail`.

```typescript
// Source: apps/engine/src/workers/step-worker.ts:155-172
if (currentAttempt <= maxRetries) {
  const delay = calculateBackOff(currentAttempt);
  await ipc.send('STEP_INCREMENT', { stepId: step.id });
  throw new StepRetryError(delay, currentAttempt + 1, err);
}
// ... else mark the step failed and bubble up
```

```typescript
// Source: apps/engine/src/workers/step-worker.ts:196-208 (the marshalling)
if (err instanceof StepRetryError) {
  const original = err.originalError instanceof Error
    ? { message: err.originalError.message, name: err.originalError.name }
    : { message: String(err.originalError) };
  throw { __stepRetry: true, delay: err.delay, attempt: err.attempt, originalError: original };
}
```

## Leader Election (Redis SET NX + Lua EXPIRE)

Atomic `SET key value EX ttl NX` for acquisition; a Lua script that checks the stored value before `EXPIRE` for renewal so a second process can't overwrite a held lease.

```typescript
// Source: apps/engine/src/services/leader-elector.ts (excerpt)
const LEADER_KEY = 'duraflow:reaper:leader';

async tryBecomeLeader(): Promise<boolean> {
    const result = await this.redis.set(LEADER_KEY, this.workerId, 'EX', this.leaderTtl, 'NX');
    if (result === 'OK') {
        this.startRenewal();
        return true;
    }
    return false;
}

private async renewLock(): Promise<boolean> {
    const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("expire", KEYS[1], ARGV[2])
        else
            return 0
        end
    `;
    const result = await this.redis.eval(script, 1, LEADER_KEY, this.workerId, this.leaderTtl);
    return result === 1;
}
```

Renewal interval is `TTL/2`. If the renew script returns 0 (value no longer matches), the elector logs `lost leadership` and stops renewing.

## Unit Test Pattern (Mocked Deps)

Pass mock objects directly into the constructor. No `jest.mock(...)` at module level. Use real timers with `await sleep(N)` rather than `jest.useFakeTimers()`.

```typescript
// Source: apps/engine/tests/unit/heartbeat.test.ts (pattern)
describe('HeartbeatService', () => {
  let mockRepo: any; // any: jest mock shape
  let heartbeat: HeartbeatService;

  beforeEach(() => {
    mockRepo = { updateHeartbeat: jest.fn().mockResolvedValue(undefined) };
    heartbeat = new HeartbeatService(mockRepo, 50);
  });

  afterEach(() => heartbeat.stopAll());

  it('starts heartbeat for a task', async () => {
    heartbeat.start('task-1');
    await sleep(150);
    expect(mockRepo.updateHeartbeat).toHaveBeenCalledWith('task-1');
  });
});
```

## Integration Test Pattern (Live PG + Redis)

Use `createTestPool()` and `createTestRedis()` from `apps/engine/tests/helpers/db.ts`. `clearTables(pool)` + `redis.flushall()` in `beforeEach`. Register named compensations before invoking the rollback orchestrator.

```typescript
// Source: apps/engine/tests/integration/saga.test.ts (excerpt)
describe("Saga Edge Cases", () => {
  let pool: Pool;
  let redis: Redis;
  let rollbackOrchestrator: RollbackOrchestrator;

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
    rollbackOrchestrator = new RollbackOrchestrator(pool);
  });

  afterAll(async () => {
    await closePool(pool);
    await redis.quit();
  });

  beforeEach(async () => {
    await clearTables(pool);
    await redis.flushall();
    resetCancellationOrder();
    resetMockBookings();
    registerCompensation("booking-saga:book-flight", cancelFlight);
    registerCompensation("booking-saga:book-hotel", cancelHotel);
    registerCompensation("booking-saga:book-car", cancelCar);
  });
});
```

## Error Serialization

Always check `instanceof Error` before reading `.message`/`.name`/`.stack`. Persist the `{ message, name, stack }` shape in JSONB columns.

```typescript
// Source: apps/engine/src/repositories/task.repository.ts:38-46
async fail(id: string, error: unknown): Promise<void> {
    const errorObj =
      error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : { message: String(error) };

    await this.pool.query(
      "UPDATE agent_tasks SET status = $1, error = $2, completed_at = NOW() WHERE id = $3",
      [taskStatus.FAILED, JSON.stringify(errorObj), id],
    );
}
```
