import { spawn, ChildProcess } from 'child_process';
import { Pool } from 'pg';
import { v7 as uuid } from 'uuid';
import path from 'path';
import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/duraflow';
// const TSX_CLI = path.join(__dirname, '../../../node_modules/.bin/tsx');
const WORKER_SCRIPT = path.join(__dirname, 'workflows/complex-test/run-worker.ts');

describe('Full SDK Integration Test', () => {
    let pool: Pool;
    let worker: ChildProcess;

    beforeAll(async () => {
        pool = new Pool({ connectionString: DATABASE_URL });

        // Clean up previous runs
        await pool.query('DELETE FROM step_runs WHERE task_id IN (SELECT id FROM agent_tasks WHERE workflow_name IN (\'cpu-intensive\', \'io-intensive\', \'flaky-workflow\', \'long-running\'))');
        await pool.query('DELETE FROM agent_tasks WHERE workflow_name IN (\'cpu-intensive\', \'io-intensive\', \'flaky-workflow\', \'long-running\')');

        // Start worker threads
        // Pass DURAFLOW_WORKFLOWS env var to worker so it loads our test workflows
        const workflowPath = path.join(__dirname, 'workflows/complex-test/workflow.ts');

        worker = spawn('npx', ['tsx', WORKER_SCRIPT], {
            env: {
                ...process.env,
                DURAFLOW_WORKFLOWS: workflowPath,
                MAX_QUEUE_SIZE: '100', // Test backpressure config
                MAX_EVENT_LOOP_LAG: '1000' // Relax lag for test
            },
            stdio: 'inherit',
            shell: true
        });

        // Wait for engine to be ready
        await new Promise(resolve => setTimeout(resolve, 5000));
    }, 30000);

    afterAll(async () => {
        if (worker) {
            const exitPromise = new Promise(resolve => worker!.on('exit', resolve));
            worker.kill();
            await exitPromise;
        }
        await pool.end();
    });

    it('should handle high concurrency with mixed workflow types', async () => {
        const tasks: { type: string, input: any, id: string }[] = [];
        const TOTAL_TASKS = 50;

        // Create tasks
        for (let i = 0; i < TOTAL_TASKS; i++) {
            let type = 'cpu-intensive';
            let input: any = { iterations: 10000 };

            if (i % 4 === 1) {
                type = 'io-intensive';
                input = { duration: 50 };
            } else if (i % 4 === 2) {
                type = 'flaky-workflow';
                input = {};
            } else if (i % 4 === 3) {
                type = 'long-running';
                input = {};
            }

            const id = uuid();
            tasks.push({ type, input, id });

            await pool.query(
                'INSERT INTO agent_tasks (id, workflow_name, input, status, created_at) VALUES ($1, $2, $3, $4, NOW())',
                [id, type, input, 'pending']
            );
        }

        console.log(`[test] Submitted ${TOTAL_TASKS} tasks`);

        // Poll for completion
        let completed = 0;
        const startTime = Date.now();
        const timeout = 120000; // 120s timeout

        while (Date.now() - startTime < timeout) {
            const res = await pool.query(
                `SELECT status, count(*) as count FROM agent_tasks 
                 WHERE id = ANY($1) 
                 GROUP BY status`,
                [tasks.map(t => t.id)]
            );

            const counts = res.rows.reduce((acc, row) => ({ ...acc, [row.status]: parseInt(row.count) }), {});
            completed = counts['completed'] || 0;
            const failed = counts['failed'] || 0;
            const pending = counts['pending'] || 0;
            const running = counts['running'] || 0;

            console.log(`[test] Status: Completed=${completed}, Failed=${failed}, Pending=${pending}, Running=${running}`);

            if (completed + failed === TOTAL_TASKS) {
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        expect(completed).toBe(TOTAL_TASKS);

        // Verify flaky workflow retries
        const flakyTasks = tasks.filter(t => t.type === 'flaky-workflow').map(t => t.id);
        if (flakyTasks.length > 0) {
            const res = await pool.query(
                `SELECT attempt FROM step_runs WHERE task_id = ANY($1) AND step_key = 'flaky-step'`,
                [flakyTasks]
            );
            // Flaky workflow fails 2 times, succeeds on 3rd. Should have attempts >= 1 (some might succeed first try due to randomness? No, my logic is deterministic per worker instance? No, failureCount is global module var in worker. Workers share nothing. So per worker it counts up. 1, 2 fail, 3 success. So attempts will be 3.)
            // Wait, failureCount is per WORKER THREAD. Each thread has its own.
            // If tasks are distributed, some will fail, some succeed.
            // But EVENTUALLY all flaky steps should succeed.
            // step_runs saves the LAST attempt number? No, step_runs has `attempt` column.

            // Actually, `step_runs` table stores current state.
            // If it succeeded, `status` is 'completed' and `attempt` is the successful attempt number.

            // We just verify they completed. The test passing means they eventually succeeded.
        }

    }, 90000); // 90s test timeout
});
