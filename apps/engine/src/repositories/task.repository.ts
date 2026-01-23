import { Pool } from "pg";
import { TaskEntity, taskStatus } from "../db/task.entity";

export class TaskRepository {
    constructor(private pool: Pool) {
    }

    async create(name: string, input: any): Promise<TaskEntity> {
        const res = await this.pool.query('INSERT INTO agent_tasks (workflow_name, input) VALUES($1, $2) RETURNING *', [name, input])
        return res.rows[0]
    }

    async findById(id: string): Promise<TaskEntity | null> {
        const res = await this.pool.query('SELECT * FROM agent_tasks WHERE id = $1', [id])
        return res?.rows[0] || null;
    }

    async updateStatus(id: string, status: taskStatus): Promise<void> {
        await this.pool.query('UPDATE agent_tasks SET status = $1 WHERE id = $2', [status, id])
    }

    async updateHeartbeat(id: string): Promise<void> {
        await this.pool.query('UPDATE agent_tasks SET heartbeat_at = NOW() WHERE id = $1', [id])
    }

    async findPendingTasks(limit: number): Promise<TaskEntity[] | null> {
        const res = await this.pool.query('SELECT * FROM agent_tasks WHERE status = $1 ORDER BY priority DESC created_at ASC LIMIT $2', [taskStatus.PENDING, limit]);
        return res?.rows
    }
}