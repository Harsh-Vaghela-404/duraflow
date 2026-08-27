-- Duraflow - canonical database schema.
--
-- This file is the single source of truth for the Duraflow Postgres schema.
-- It is executed in two ways:
--   1. Automatically by the postgres:16-alpine container on first startup,
--      via the official /docker-entrypoint-initdb.d/ mechanism. Runs once
--      per fresh volume - if you `docker compose down -v`, the next `up`
--      re-runs this script.
--   2. Manually via `tsx apps/engine/src/db/migrate.ts` against an
--      already-running database. Idempotent (CREATE TABLE IF NOT EXISTS).
--
-- Keep this file aligned with the entity interfaces in this directory
-- (task.entity.ts, step_runs.entity.ts, dead_letter_queue.entity.ts).

-- ============================================================
-- agent_tasks - durable workflow task queue
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_name   VARCHAR(255) NOT NULL,
    status          VARCHAR(50)  NOT NULL DEFAULT 'pending',
    input           JSONB        DEFAULT '{}'::jsonb,
    output          JSONB,
    error           JSONB,
    priority        INTEGER      DEFAULT 0,
    scheduled_at    TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    heartbeat_at    TIMESTAMPTZ,
    worker_id       VARCHAR(255),
    retry_count     INTEGER      DEFAULT 0,
    max_retries     INTEGER      DEFAULT 3,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

-- runtime telcac: 'node' = internal TS executor, 'python' = external worker
ALTER TABLE agent_tasks
    ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'node';

-- ============================================================
-- step_runs - per-step execution records (memoization + saga)
-- ============================================================
CREATE TABLE IF NOT EXISTS step_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    step_key        VARCHAR(255) NOT NULL,
    status          VARCHAR(50)  NOT NULL DEFAULT 'pending',
    input           JSONB,
    output          JSONB,
    error           JSONB,
    compensation_fn TEXT,
    compensated_at  TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    attempt         INTEGER      DEFAULT 0,
    UNIQUE (task_id, step_key)
);

-- ============================================================
-- dead_letter_queue - failed compensations for operator retry
-- ============================================================
CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      UUID NOT NULL,
    step_id      UUID NOT NULL,
    error        JSONB,
    retry_count  INTEGER     DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================

-- Hot path: poller dequeue. Partial index on status='pending' only.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_scheduled_priority
    ON agent_tasks (status, scheduled_at, priority DESC)
    WHERE status = 'pending';

-- Step lookup by task (memoization, rollback ordering).
CREATE INDEX IF NOT EXISTS idx_step_runs_task_id
    ON step_runs (task_id);

-- DLQ list by task (operator UI).
CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_task_id
    ON dead_letter_queue (task_id);
