import { spawn, ChildProcess } from 'child_process';
import { Pool } from 'pg';
import { v7 as uuid } from 'uuid';
import path from 'path';
import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/duraflow';
const pool = new Pool({ connectionString: DATABASE_URL });

const WORKER_SCRIPT = path.join(__dirname, 'workflows/worker-thread-test/run-worker.ts');
const TSX_CLI = path.resolve(__dirname, '../../../node_modules/tsx/dist/cli.cjs');

describe('Worker Thread Integration', () => {
    let worker: ChildProcess | null = null;

    beforeAll(async () => {
        await pool.query('DELETE FROM step_runs WHERE task_id IN (SELECT id FROM agent_tasks WHERE workflow_name = $1)', ['worker-thread-test']);
        await pool.query('DELETE FROM agent_tasks WHERE workflow_name = $1', ['worker-thread-test']);
    });

    afterAll(async () => {
        if (worker) {
            const exitPromise = new Promise(resolve => worker!.on('exit', resolve));
            worker.kill();
            await exitPromise;
        }
        await pool.end();
    });

    test('workflow executes in worker thread', async () => {
        const taskId = uuid();

        await pool.query(
            "INSERT INTO agent_tasks (id, workflow_name, input, status) VALUES ($1, 'worker-thread-test', '{\"value\": 42}', 'pending')",
            [taskId]
        );

        const workflowPath = path.join(__dirname, 'workflows/worker-thread-test/workflow.ts');
        worker = spawn('node', [TSX_CLI, WORKER_SCRIPT], {
            env: {
                ...process.env,
                PORT: '50060',
                DURAFLOW_WORKFLOWS: workflowPath
            },
            shell: true,
            stdio: 'inherit'
        });

        let completed = false;
        let output: unknown = null;

        for (let i = 0; i < 30; i++) {
            const res = await pool.query('SELECT status, output FROM agent_tasks WHERE id = $1', [taskId]);
            const task = res.rows[0];

            if (task.status === 'completed') {
                completed = true;
                output = task.output;
                break;
            }

            if (task.status === 'failed') {
                throw new Error(`Task failed: ${JSON.stringify(task.error)}`);
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        expect(completed).toBe(true);
        expect(output).toBeDefined();
    }, 35000);

    test('retry logic works with worker threads', async () => {
        const taskId = uuid();

        await pool.query(
            "INSERT INTO agent_tasks (id, workflow_name, input, status) VALUES ($1, 'worker-thread-test', '{\"shouldFail\": 2}', 'pending')",
            [taskId]
        );

        // Worker should already be running from previous test
        let completed = false;
        let stepAttempts = 0;

        for (let i = 0; i < 60; i++) {
            const res = await pool.query('SELECT status FROM agent_tasks WHERE id = $1', [taskId]);
            const task = res.rows[0];

            if (task.status === 'completed') {
                completed = true;
                const steps = await pool.query('SELECT attempt FROM step_runs WHERE task_id = $1 AND step_key = $2', [taskId, 'flaky-step']);
                if (steps.rows[0]) {
                    stepAttempts = steps.rows[0].attempt;
                }
                break;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        expect(completed).toBe(true);
        expect(stepAttempts).toBeGreaterThanOrEqual(2);
    }, 65000);
});
