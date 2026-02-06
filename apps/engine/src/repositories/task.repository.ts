import { Pool } from "pg";
import { TaskEntity, taskStatus } from "../db/task.entity";

export class TaskRepository {
    constructor(private pool: Pool) { }

    async create(name: string, input: Record<string, any>): Promise<TaskEntity> {
        const res = await this.pool.query(
            'INSERT INTO agent_tasks (workflow_name, input) VALUES($1, $2) RETURNING *',
            [name, input]
        );
        return res.rows[0];
    }

    async findById(id: string): Promise<TaskEntity | null> {
        const res = await this.pool.query('SELECT * FROM agent_tasks WHERE id = $1', [id]);
        return res?.rows[0] || null;
    }

    async updateStatus(id: string, status: taskStatus): Promise<void> {
        await this.pool.query('UPDATE agent_tasks SET status = $1 WHERE id = $2', [status, id]);
    }

    async updateCompleted(id: string, output: unknown): Promise<void> {
        await this.pool.query(
            'UPDATE agent_tasks SET status = $1, output = $2, completed_at = NOW() WHERE id = $3',
            [taskStatus.COMPLETED, JSON.stringify(output), id]
        );
    }

    async fail(id: string, error: unknown): Promise<void> {
        const errorObj = error instanceof Error
            ? { message: error.message, name: error.name, stack: error.stack }
            : { message: String(error) };

        await this.pool.query(
            'UPDATE agent_tasks SET status = $1, error = $2, completed_at = NOW() WHERE id = $3',
            [taskStatus.FAILED, JSON.stringify(errorObj), id]
        );
    }

    async updateHeartbeat(id: string): Promise<void> {
        await this.pool.query('UPDATE agent_tasks SET heartbeat_at = NOW() WHERE id = $1', [id]);
    }

    async findPendingTasks(limit: number): Promise<TaskEntity[] | null> {
        const res = await this.pool.query(
            'SELECT * FROM agent_tasks WHERE status = $1 ORDER BY priority DESC, created_at ASC LIMIT $2',
            [taskStatus.PENDING, limit]
        );
        return res?.rows;
    }

    async dequeue(batchSize: number, workerId: string): Promise<TaskEntity[]> {
        const query = `
            WITH next_jobs AS (
                SELECT id FROM agent_tasks 
                WHERE status = $1 AND (scheduled_at <= NOW() OR scheduled_at IS NULL)
                ORDER BY priority DESC, created_at ASC
                LIMIT $2
                FOR UPDATE SKIP LOCKED 
            )
            UPDATE agent_tasks 
            SET 
                status = $3, 
                worker_id = $4, 
                heartbeat_at = NOW() 
            FROM next_jobs 
            WHERE agent_tasks.id = next_jobs.id
            RETURNING agent_tasks.*
        `;
        const res = await this.pool.query(query, [taskStatus.PENDING, batchSize, taskStatus.RUNNING, workerId]);
        return res?.rows || [];
    }

    async scheduleRetry(id: string, delayMs: number, attempt: number, error: unknown): Promise<void> {
        const errorObj = error instanceof Error
            ? { message: error.message, name: error.name, stack: error.stack }
            : { message: String(error) };

            const query = `
            UPDATE agent_tasks
            SET
                status = $1,
                scheduled_at = NOW() + ($2 || ' milliseconds')::INTERVAL,
                retry_count = $3,
                error = $4,
                heartbeat_at = NULL,
                worker_id = NULL
            WHERE id = $5
        `;

        await this.pool.query(query, [
            taskStatus.PENDING,
            delayMs,
            attempt,
            JSON.stringify(errorObj),
            id
        ]);
    } 
}