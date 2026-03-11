import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://duraflow:duraflow@localhost:5432/duraflow",
});

async function migrate() {
  const client = await pool.connect();

  try {
    // Create agent_tasks table
    await client.query(`
            CREATE TABLE IF NOT EXISTS agent_tasks (
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
        `);
    console.log("Created agent_tasks table");

    // Create step_runs table
    await client.query(`
            CREATE TABLE IF NOT EXISTS step_runs (
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
        `);
    console.log("Created step_runs table");

    // Create dead_letter_queue table
    await client.query(`
            CREATE TABLE IF NOT EXISTS dead_letter_queue (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                task_id UUID NOT NULL,
                step_id UUID NOT NULL,
                error JSONB,
                retry_count INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
    console.log("Created dead_letter_queue table");

    // Create indexes
    await client.query(`
            CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_scheduled_priority 
            ON agent_tasks(status, scheduled_at, priority DESC) 
            WHERE status = 'pending';
        `);
    console.log("Created partial index on agent_tasks");

    await client.query(`
            CREATE INDEX IF NOT EXISTS idx_step_runs_task_id ON step_runs(task_id);
        `);
    console.log("Created index on step_runs.task_id");

    await client.query(`
            CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_task_id ON dead_letter_queue(task_id);
        `);
    console.log("Created index on dead_letter_queue.task_id");

    console.log("Migration complete!");
  } catch (err) {
    console.error("Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
