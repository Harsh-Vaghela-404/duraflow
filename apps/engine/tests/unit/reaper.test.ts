import { Pool } from 'pg';
import Redis from 'ioredis';
import { Reaper } from '../../src/services/reaper';
import { createTestPool, createTestRedis, closePool, clearTables, createTask, updateTaskStatus } from '../helpers/db';
import { taskStatus } from '../../src/db/task.entity';
import { sleep } from '../helpers/poll';

describe('Reaper', () => {
    let pool: Pool;
    let redis: Redis;
    let reaper: Reaper;

    beforeAll(async () => {
        pool = createTestPool();
        redis = createTestRedis();
        reaper = new Reaper(pool, redis, 1, 100); // 1s stale threshold, 100ms interval
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

    it('requeues stale running tasks', async () => {
        const task = await createTask(pool, 'stale-wf', {});
        // Manual SQL to force a stale heartbeat
        await pool.query(
            "UPDATE agent_tasks SET status = 'running', heartbeat_at = NOW() - INTERVAL '2 seconds', worker_id = 'dead-worker' WHERE id = $1",
            [task.id]
        );

        await reaper.reap();

        const updated = await pool.query('SELECT * FROM agent_tasks WHERE id = $1', [task.id]);
        expect(updated.rows[0].status).toBe('pending');
        expect(updated.rows[0].worker_id).toBeNull();
        expect(updated.rows[0].retry_count).toBe(1);
    });

    it('fails tasks that exceeded max retries', async () => {
        const task = await createTask(pool, 'retry-limit-wf', {});
        await pool.query(
            "UPDATE agent_tasks SET status = 'running', heartbeat_at = NOW() - INTERVAL '2 seconds', retry_count = 3, max_retries = 3 WHERE id = $1",
            [task.id]
        );

        await reaper.reap();

        const updated = await pool.query('SELECT * FROM agent_tasks WHERE id = $1', [task.id]);
        expect(updated.rows[0].status).toBe('failed');
        expect(updated.rows[0].error).toBeDefined();
    });

    it('does not touch active tasks', async () => {
        const task = await createTask(pool, 'active-wf', {});
        await updateTaskStatus(pool, task.id, taskStatus.RUNNING);
        await pool.query("UPDATE agent_tasks SET heartbeat_at = NOW() WHERE id = $1", [task.id]);

        const reaped = await reaper.reap();
        expect(reaped).toHaveLength(0);

        const updated = await pool.query('SELECT status FROM agent_tasks WHERE id = $1', [task.id]);
        expect(updated.rows[0].status).toBe('running');
    });
});
