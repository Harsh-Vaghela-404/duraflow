import { spawn, ChildProcess } from 'child_process';
import { Pool } from 'pg';
import { v7 as uuid } from 'uuid';
import path from 'path';
import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/duraflow';
const pool = new Pool({ connectionString: DATABASE_URL });

const WORKER_SCRIPT = path.join(__dirname, 'workflows/crash-test/run-retry-worker.ts');
const TSX_CLI = path.resolve(__dirname, '../../../node_modules/tsx/dist/cli.cjs');

describe('Retry Logic Integration', () => {
    let worker: ChildProcess | null = null;

    beforeAll(async () => {
        await pool.query('DELETE FROM agent_tasks WHERE workflow_name = $1', ['retry-test']);
        await pool.query('DELETE FROM step_runs WHERE task_id IN (SELECT id FROM agent_tasks WHERE workflow_name = $1)', ['retry-test']);
    });

    afterAll(async () => {
        if (worker) worker.kill();
        await pool.end();
    });

    test('should retry failed steps with backoff', async () => {
        const taskId = uuid();

        // 1. Create Task
        await pool.query(
            "INSERT INTO agent_tasks (id, workflow_name, input, status) VALUES ($1, 'retry-test', '{}', 'pending')",
            [taskId]
        );

        // 2. Start Worker
        worker = spawn('node', [TSX_CLI, WORKER_SCRIPT], {
            env: { ...process.env, PORT: '50059' },
            shell: true,
            stdio: 'inherit'
        });

        let attempts = 0;
        let completed = false;

        for (let i = 0; i < 40; i++) { // Wait up to 40s
            const res = await pool.query('SELECT status, retry_count FROM agent_tasks WHERE id = $1', [taskId]);
            const task = res.rows[0];

            if (task.status === 'completed') {
                completed = true;
                break;
            }

            // Check step attempts
            const steps = await pool.query('SELECT step_key, attempt, status, started_at FROM step_runs WHERE task_id = $1 AND step_key = $2', [taskId, 'process']);
            if (steps.rows.length > 0) {
                attempts = steps.rows[0].attempt;
                const startedAt = steps.rows[0].started_at;
                if (startedAt) console.log(`[test] started_at detected: ${startedAt}`);
                console.log(`[test] Task status: ${task.status}, Step attempt: ${attempts}`);
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        expect(completed).toBe(true);
        expect(attempts).toBe(3); // Should have succeeded on 3rd attempt
    }, 45000);
});
