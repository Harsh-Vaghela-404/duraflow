# Database Schema

Duraflow uses PostgreSQL for persistent storage. This document describes the database schema.

## Tables Overview

| Table               | Purpose                     |
| ------------------- | --------------------------- |
| `agent_tasks`       | Workflow task records       |
| `step_runs`         | Step execution checkpoints  |
| `dead_letter_queue` | Failed compensation records |

---

## agent_tasks

Stores workflow task (run) information.

```sql
CREATE TABLE agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  input JSONB DEFAULT '{}',
  output JSONB,
  error JSONB,
  priority INTEGER DEFAULT 0,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  worker_id VARCHAR(255),
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
```

### Columns

| Column          | Type         | Description                                                                                   |
| --------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `id`            | UUID         | Primary key, unique task identifier                                                           |
| `workflow_name` | VARCHAR(255) | Name of the workflow to execute                                                               |
| `status`        | VARCHAR(50)  | Current task status (pending/running/completed/failed/cancelled/rolled_back/partial_rollback) |
| `input`         | JSONB        | Workflow input data                                                                           |
| `output`        | JSONB        | Workflow output (set on completion)                                                           |
| `error`         | JSONB        | Error details (set on failure)                                                                |
| `priority`      | INTEGER      | Task priority (higher = first)                                                                |
| `scheduled_at`  | TIMESTAMPTZ  | When task should run                                                                          |
| `started_at`    | TIMESTAMPTZ  | When task started processing                                                                  |
| `completed_at`  | TIMESTAMPTZ  | When task completed                                                                           |
| `heartbeat_at`  | TIMESTAMPTZ  | Last heartbeat update                                                                         |
| `worker_id`     | VARCHAR(255) | ID of worker processing task                                                                  |
| `retry_count`   | INTEGER      | Number of retries after worker death                                                          |
| `max_retries`   | INTEGER      | Maximum retry attempts                                                                        |
| `created_at`    | TIMESTAMPTZ  | Creation timestamp                                                                            |
| `updated_at`    | TIMESTAMPTZ  | Last update timestamp                                                                         |

### Indexes

```sql
-- Partial index for pending task queries (most common query)
CREATE INDEX idx_agent_tasks_status_scheduled_priority
ON agent_tasks(status, scheduled_at, priority DESC)
WHERE status = 'pending';

-- For heartbeat-based staleness detection
CREATE INDEX idx_agent_tasks_heartbeat
ON agent_tasks(heartbeat_at)
WHERE status = 'running';
```

---

## step_runs

Stores step execution results for crash recovery and memoization.

```sql
CREATE TABLE step_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  step_key VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  input JSONB,
  output JSONB,
  error JSONB,
  compensation_fn TEXT,
  compensated_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  attempt INTEGER DEFAULT 0,
  UNIQUE(task_id, step_key)
);
```

### Columns

| Column            | Type         | Description                                    |
| ----------------- | ------------ | ---------------------------------------------- |
| `id`              | UUID         | Primary key                                    |
| `task_id`         | UUID         | Foreign key to agent_tasks                     |
| `step_key`        | VARCHAR(255) | Unique step identifier within the workflow     |
| `status`          | VARCHAR(50)  | Step status (pending/running/completed/failed) |
| `input`           | JSONB        | Step input data                                |
| `output`          | JSONB        | Step output (for memoization)                  |
| `error`           | JSONB        | Error details if failed                        |
| `compensation_fn` | TEXT         | Compensation function name (for saga)          |
| `compensated_at`  | TIMESTAMPTZ  | When compensation executed                     |
| `started_at`      | TIMESTAMPTZ  | When step started                              |
| `completed_at`    | TIMESTAMPTZ  | When step completed                            |
| `attempt`         | INTEGER      | Current retry attempt number                   |

### Indexes

```sql
-- For memoization lookup
CREATE UNIQUE INDEX idx_step_runs_task_step
ON step_runs(task_id, step_key);

-- For rollback queries
CREATE INDEX idx_step_runs_compensation
ON step_runs(task_id)
WHERE compensation_fn IS NOT NULL;
```

---

## dead_letter_queue

Stores failed compensation records for manual intervention.

```sql
CREATE TABLE dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  step_id UUID NOT NULL,
  error JSONB,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Columns

| Column        | Type        | Description                                 |
| ------------- | ----------- | ------------------------------------------- |
| `id`          | UUID        | Primary key                                 |
| `task_id`     | UUID        | Reference to failed task                    |
| `step_id`     | UUID        | Reference to step whose compensation failed |
| `error`       | JSONB       | Full error details                          |
| `retry_count` | INTEGER     | Number of retry attempts                    |
| `created_at`  | TIMESTAMPTZ | When DLQ entry created                      |

### Indexes

```sql
-- For task-based DLQ queries
CREATE INDEX idx_dlq_task_id ON dead_letter_queue(task_id);
```

---

## Task Lifecycle & Data Flow

### Creating a Task

```typescript
// Via gRPC
await client.submitTask({
  workflowName: "order-processing",
  input: JSON.stringify({ orderId: "123" }),
});

// Inserted into agent_tasks:
// { status: "pending", input: {...}, ... }
```

### Processing a Task

```typescript
// 1. Worker claims task (SKIP LOCKED)
UPDATE agent_tasks
SET status = "running", worker_id = "worker-1", heartbeat_at = NOW()
WHERE id = 'task-id' AND status = 'pending';

// 2. For each step:
INSERT INTO step_runs (task_id, step_key, status)
VALUES ('task-id', 'validate-order', 'running');

UPDATE step_runs
SET status = "completed", output = {...}, completed_at = NOW()
WHERE id = 'step-id';
```

### Task Completion

```typescript
// Success
UPDATE agent_tasks
SET status = "completed", output = {...}, completed_at = NOW()
WHERE id = 'task-id';

// Failure
UPDATE agent_tasks
SET status = "failed", error = {...}, completed_at = NOW()
WHERE id = 'task-id';
```

### Saga Rollback

```typescript
// Find completed steps with compensation
SELECT * FROM step_runs
WHERE task_id = 'task-id'
AND status = 'completed'
AND compensation_fn IS NOT NULL
ORDER BY completed_at DESC;  -- LIFO

// Execute compensations...

// Mark as compensated
UPDATE step_runs
SET compensated_at = NOW()
WHERE id = 'step-id';

// Final status
UPDATE agent_tasks
SET status = "rolled_back"  -- or "partial_rollback" if any failed
WHERE id = 'task-id';

// Failed compensations go to DLQ
INSERT INTO dead_letter_queue (task_id, step_id, error)
VALUES ('task-id', 'step-id', {...});
```

---

## Query Examples

### Find pending tasks

```sql
SELECT * FROM agent_tasks
WHERE status = 'pending'
ORDER BY priority DESC, created_at ASC
LIMIT 10;
```

### Find stale running tasks

```sql
SELECT * FROM agent_tasks
WHERE status = 'running'
AND heartbeat_at < NOW() - INTERVAL '30 seconds';
```

### Check step memoization

```sql
SELECT * FROM step_runs
WHERE task_id = 'task-id'
AND step_key = 'validate-order'
AND status = 'completed';
```

### Find failed compensations

```sql
SELECT dlq.*, at.workflow_name
FROM dead_letter_queue dlq
JOIN agent_tasks at ON dlq.task_id = at.id
ORDER BY dlq.created_at DESC;
```

---

## Migrations

Run migrations with:

```bash
cd apps/engine
npx tsx src/db/migrate.ts
```

The migration script creates all tables and indexes automatically.
