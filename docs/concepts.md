# Core Concepts

Understanding these concepts will help you use Duraflow effectively.

## Workflow

A **workflow** is a named function that defines a series of steps to execute. Each workflow:

- Has a unique name (alphanumeric, dashes, underscores)
- Receives input data
- Returns output when complete
- Can have any number of steps

```typescript
const myWorkflow = workflow("my-workflow", async (ctx) => {
  // ctx.runId - unique identifier for this run
  // ctx.workflowName - "my-workflow"
  // ctx.input - the input data passed to the workflow
  // ctx.step - the step runner
  return { result: "done" };
});
```

## Step

A **step** is a single unit of work within a workflow. Steps are executed sequentially and each step:

- Has a unique name within the workflow
- Can return data (output) that persists to database
- Can be retried on failure
- Can have compensation for rollback

```typescript
const result = await ctx.step.run(
  "step-name",
  async () => {
    return { data: "output" };
  },
  {
    retries: 3, // Retry 3 times on failure
    timeout: 30000, // 30 second timeout
    compensation: async (output) => {
      // Undo the step's effects
    },
  },
);
```

## Crash Recovery (Memoization)

Duraflow automatically saves each step's output to the database. When a workflow restarts after a crash:

1. Duraflow queries `step_runs` table for completed steps
2. If a step is already COMPLETED, it returns the cached output (no re-execution)
3. Only incomplete steps are executed

This is called **memoization** - the same step never runs twice.

```sql
-- step_runs table stores step outputs
SELECT * FROM step_runs
WHERE task_id = '...' AND step_key = 'validate-order'
AND status = 'completed';
```

## Task Lifecycle

```
┌─────────┐     ┌─────────┐     ┌────────────┐     ┌──────────┐
│ PENDING │────▶│ RUNNING │────▶│ COMPLETED   │     │          │
└─────────┘     └─────────┘     └────────────┘     │          │
    │               │               │               │          │
    │               │               │               ▼          │
    │               │               │         ┌──────────┐    │
    │               │               │         │  FAILED   │    │
    │               │               │         └──────────┘    │
    │               │               │               │          │
    │               │               │               ▼          │
    │               │               │         ┌────────────┐  │
    │               │               │         │ ROLLED_BACK │◀───┘
    │               │               │         └────────────┘      │
    │               │               │               │            │
    │               │               │               ▼            │
    │               │               │         ┌───────────────┐  │
    │               │               │         │PARTIAL_ROLLBACK│
    └───────────────┴───────────────┴─────────┴───────────────┘
                            │
                            ▼
                      ┌────────────┐
                      │ CANCELLED  │
                      └────────────┘
```

## Multi-Worker Architecture

Duraflow supports multiple workers processing tasks concurrently:

```
Worker 1                    Worker 2                    Worker 3
   │                          │                          │
   ▼                          ▼                          ▼
┌─────────┐              ┌─────────┐              ┌─────────┐
│ Dequeue │              │ Dequeue │              │ Dequeue │
│  Task   │              │  Task   │              │  Task   │
└─────────┘              └─────────┘              └─────────┘
   │                          │                          │
   ▼                          ▼                          ▼
┌─────────┐              ┌─────────┐              ┌─────────┐
│ SKIP    │              │ SKIP    │              │  Claim  │
│ LOCKED  │              │ LOCKED   │              │  Task   │
└─────────┘              └─────────┘              └─────────┘
```

### SKIP LOCKED

PostgreSQL's `FOR UPDATE SKIP LOCKED` ensures:

- Only one worker claims a task
- Other workers skip already-locked tasks
- No duplicate processing

## Heartbeat & Reaper

### Heartbeat

While a worker processes a task, it updates `heartbeat_at` every 5 seconds:

```sql
UPDATE agent_tasks
SET heartbeat_at = NOW()
WHERE id = 'task-id';
```

### Reaper

The Reaper runs every 10 seconds to find stale tasks:

```sql
SELECT * FROM agent_tasks
WHERE status = 'running'
AND heartbeat_at < NOW() - INTERVAL '30 seconds';
```

For each stale task:

- If retries remain: reset to PENDING (will be retried)
- If retries exhausted: mark as FAILED

## Leader Election

Only one worker runs the Reaper to avoid duplicate work. Uses Redis:

```lua
-- Only set if key doesn't exist, expire after 30 seconds
SETNX "duraflow:reaper:leader" "worker-1" EX 30
```

## Saga Pattern

When a workflow fails, Duraflow can automatically undo completed steps:

1. Find all completed steps with compensation functions
2. Execute in **reverse order** (LIFO)
3. If compensation fails: add to Dead Letter Queue
4. Continue with remaining compensations

```typescript
await ctx.step.run(
  "book-flight",
  async () => {
    return await api.bookFlight(details);
  },
  {
    compensation: async (output) => {
      await api.cancelFlight(output.flightId);
    },
  },
);
```

## Dead Letter Queue (DLQ)

Failed compensations are stored for manual intervention:

```sql
-- Table structure
INSERT INTO dead_letter_queue (task_id, step_id, error)
VALUES ('task-123', 'step-456', '{"message": "Cancel failed"}');
```

To retry:

```typescript
await dlqRepo.retry(dlqItemId);
```

## Backpressure

When the system is overloaded, Duraflow automatically slows down:

1. **Queue Full**: If worker pool queue > 1000, stop polling
2. **Event Loop Lag**: If lag > 100ms, reduce polling frequency

---

## Key Terms

| Term         | Description                                     |
| ------------ | ----------------------------------------------- |
| Task         | A single workflow execution                     |
| Step         | A single unit of work within a workflow         |
| Memoization  | Saving step output to avoid re-execution        |
| Compensation | Function to undo a step's effects               |
| LIFO         | Last In First Out - rollback order              |
| SKIP LOCKED  | PostgreSQL feature for concurrent task claiming |
| Reaper       | Service that recovers tasks from dead workers   |
| DLQ          | Dead Letter Queue for failed compensations      |
