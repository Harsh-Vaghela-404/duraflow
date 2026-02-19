import 'dotenv/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { TaskEntity, taskStatus } from '../../src/db/task.entity';

export const TEST_DB_URL = process.env.DATABASE_URL || 'postgresql://duraflow:duraflow@localhost:5432/duraflow';
export const TEST_REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export function createTestPool(): Pool {
    return new Pool({ connectionString: TEST_DB_URL, max: 5 });
}

export function createTestRedis(): Redis {
    return new Redis(TEST_REDIS_URL, { lazyConnect: true });
}

export async function clearTables(pool: Pool): Promise<void> {
    await pool.query('TRUNCATE TABLE step_runs, agent_tasks RESTART IDENTITY CASCADE');
}

export async function closePool(pool: Pool): Promise<void> {
    await pool.end();
}

export async function createTask(pool: Pool, name: string, input: any = {}): Promise<TaskEntity> {
    const res = await pool.query(
        'INSERT INTO agent_tasks (workflow_name, input) VALUES ($1, $2) RETURNING *',
        [name, JSON.stringify(input)]
    );
    return res.rows[0];
}

export async function getTask(pool: Pool, id: string): Promise<TaskEntity> {
    const res = await pool.query('SELECT * FROM agent_tasks WHERE id = $1', [id]);
    return res.rows[0];
}

export async function updateTaskStatus(pool: Pool, id: string, status: taskStatus): Promise<void> {
    await pool.query('UPDATE agent_tasks SET status = $1 WHERE id = $2', [status, id]);
}
