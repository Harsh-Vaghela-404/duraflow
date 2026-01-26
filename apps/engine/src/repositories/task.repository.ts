import { Pool } from "pg";
import { TaskEntity, taskStatus } from "../db/task.entity";

export class TaskRepository {
    constructor(private pool: Pool) { }

    /**
     * Creates a new task in the database.
     * @param name The name of the workflow.
     * @param input The input data for the task.
     * @returns A promise that resolves to the created TaskEntity.
     */
    async create(name: string, input: any): Promise<TaskEntity> {
        const res = await this.pool.query(
            'INSERT INTO agent_tasks (workflow_name, input) VALUES($1, $2) RETURNING *',
            [name, input]
        );
        return res.rows[0];
    }

    /**
     * Finds a task by its ID.
     * @param id The ID of the task.
     * @returns A promise that resolves to the TaskEntity if found, otherwise null.
     */
    async findById(id: string): Promise<TaskEntity | null> {
        const res = await this.pool.query('SELECT * FROM agent_tasks WHERE id = $1', [id]);
        return res?.rows[0] || null;
    }

    /**
     * Updates the status of a task.
     * @param id The ID of the task.
     * @param status The new status for the task.
     * @returns A promise that resolves when the update is complete.
     */
    async updateStatus(id: string, status: taskStatus): Promise<void> {
        await this.pool.query('UPDATE agent_tasks SET status = $1 WHERE id = $2', [status, id]);
    }

    /**
     * Updates the heartbeat timestamp of a task.
     * @param id The ID of the task.
     * @returns A promise that resolves when the update is complete.
     */
    async updateHeartbeat(id: string): Promise<void> {
        await this.pool.query('UPDATE agent_tasks SET heartbeat_at = NOW() WHERE id = $1', [id]);
    }

    /**
     * Finds a specified number of pending tasks, ordered by priority and creation time.
     * @param limit The maximum number of pending tasks to retrieve.
     * @returns A promise that resolves to an array of TaskEntity objects, or null if none are found.
     */
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

}