import { spawn, ChildProcess } from 'child_process';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { v7 as uuid } from 'uuid';
import path from 'path';
import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/duraflow';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const pool = new Pool({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL);

const WORKER_SCRIPT = path.join(__dirname, 'run-crash-worker.ts');

describe('Crash Recovery Integration', () => {
    let crashWorker: ChildProcess | null = null;
    let recoveryWorker: ChildProcess | null = null;

    beforeAll(async () => {
        // Cleanup old data
        await pool.query('DELETE FROM agent_tasks WHERE workflow_name = $1', ['crash-test']);
        await pool.query('DELETE FROM step_runs WHERE task_id IN (SELECT id FROM agent_tasks WHERE workflow_name = $1)', ['crash-test']);

        // Reset counters
        const keys = await redis.keys('crash-test:step-*');
        if (keys.length > 0) await redis.del(...keys);
    }, 30000);

    afterAll(async () => {
        if (crashWorker) crashWorker.kill();
        if (recoveryWorker) recoveryWorker.kill();
        await pool.end();
        await redis.quit();
    });

    test('should resume workflow after crash from last checkpoint', async () => {
        const taskId = uuid();

        // 1. Create Task in DB
        await pool.query(
            "INSERT INTO agent_tasks (id, workflow_name, input, status) VALUES ($1, 'crash-test', '{}', 'pending')",
            [taskId]
        );

        console.log(`[test] Created task ${taskId}`);

        // Define CLI path
        const tsxCliPath = path.resolve(__dirname, '../../../node_modules/tsx/dist/cli.cjs');

        // 2. Start Worker with CRASH configuration
        console.log(`[test] Starting CRASH worker using node ${tsxCliPath}`);

        const exitPromise = new Promise<number | null>((resolve) => {
            crashWorker = spawn('node', [tsxCliPath, WORKER_SCRIPT], {
                env: {
                    ...process.env,
                    CRASH_AFTER_STEP: '3',
                    PORT: '50052',
                    REAPER_STALE_THRESHOLD: '5',
                    REAPER_INTERVAL: '2000',
                    LEADER_TTL_SECONDS: '2'
                },
                shell: true,
                stdio: 'inherit'
            });
            crashWorker.on('exit', (code) => resolve(code));
        });

        // 3. Wait for crash (Code 1)
        const code = await exitPromise;
        console.log(`[test] Worker exited with code ${code}`);
        expect(code).toBe(1);

        // 4. Verify Intermediate State
        const steps = await pool.query('SELECT * FROM step_runs WHERE task_id = $1', [taskId]);
        expect(steps.rows.length).toBe(3); // Steps 1, 2, 3 completed

        const c1 = await redis.get('crash-test:step-1');
        const c3 = await redis.get('crash-test:step-3');
        const c4 = await redis.get('crash-test:step-4');

        expect(c1).toBe('1');
        expect(c3).toBe('1');
        expect(c4).toBeNull(); // Step 4 didn't run

        // 5. Restart Worker (Recovery) without crash config
        console.log('[test] Starting RECOVERY worker (waiting 6s for leader lock expiration)...');
        await new Promise(r => setTimeout(r, 6000));

        console.log('[test] Spawning RECOVERY worker...');

        recoveryWorker = spawn('node', [tsxCliPath, WORKER_SCRIPT], {
            env: {
                ...process.env,
                PORT: '50052',
                REAPER_STALE_THRESHOLD: '5',
                REAPER_INTERVAL: '2000',
                LEADER_TTL_SECONDS: '2'
            },
            shell: true,
            stdio: 'inherit'
        });

        // 6. Poll for Completion
        console.log('[test] Waiting for completion...');
        let status = 'pending';
        for (let i = 0; i < 30; i++) { // Wait up to 30s
            const res = await pool.query('SELECT status FROM agent_tasks WHERE id = $1', [taskId]);
            status = res.rows[0].status;
            if (status === 'completed' || status === 'failed') break;
            await new Promise(r => setTimeout(r, 1000));
        }

        expect(status).toBe('completed');

        // 7. Verify Final State (Memoization + Resume)
        const c1_final = await redis.get('crash-test:step-1');
        const c3_final = await redis.get('crash-test:step-3');
        const c4_final = await redis.get('crash-test:step-4');
        const c5_final = await redis.get('crash-test:step-5');

        expect(c1_final).toBe('1'); // Should NOT execute again (memoized)
        expect(c3_final).toBe('1');
        expect(c4_final).toBe('1'); // Executed once
        expect(c5_final).toBe('1');

        console.log('[test] Recovery verified successfully!');

    }, 60000); // 60s timeout
});
