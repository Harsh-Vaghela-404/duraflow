import { Pool } from 'pg';
import Redis from 'ioredis';
import { Reaper } from '../../src/services/reaper';
import { createTestPool, createTestRedis, closePool, clearTables, createTask, updateTaskStatus } from '../helpers/db';
import { taskStatus } from '../../src/db/task.entity';
import { sleep, waitUntil } from '../helpers/poll';

describe('Crash Recovery Integration', () => {
    let pool: Pool;
    let redis: Redis;
    let reaper: Reaper;

    beforeAll(async () => {
        pool = createTestPool();
        redis = createTestRedis();
        reaper = new Reaper(pool, redis, 1, 100); // 1s stale threshold
    });

    afterAll(async () => {
        await reaper.stop();
        await closePool(pool);
        await redis.quit();
    });

    beforeEach(async () => {
        await clearTables(pool);
        await redis.flushall();
    });

    it('recovers a crashed task and makes it pending', async () => {
        // 1. Simulate a task that was running on a dead worker
        const task = await createTask(pool, 'crashed-wf', {});
        await pool.query(
            "UPDATE agent_tasks SET status = 'running', heartbeat_at = NOW() - INTERVAL '2 seconds', worker_id = 'dead-worker' WHERE id = $1",
            [task.id]
        );

        // 2. Start the reaper
        await reaper.start();

        // 3. Wait for recovery
        await waitUntil(async () => {
            const res = await pool.query('SELECT status, worker_id, retry_count FROM agent_tasks WHERE id = $1', [task.id]);
            const t = res.rows[0];
            return t.status === 'pending' && t.worker_id === null && t.retry_count === 1;
        }, 3000);

        await reaper.stop();
    });
});
