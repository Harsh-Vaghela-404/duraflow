import { Pool } from 'pg';
import { DeadLetterQueueEntity } from '../db/dead_letter_queue.entity';

export class DeadLetterQueueRepository {
    constructor(private readonly pool: Pool) { }

    async insert(taskId: string, stepId: string, error: unknown): Promise<DeadLetterQueueEntity> {
        const errorObj = error instanceof Error
            ? { message: error.message, name: error.name, stack: error.stack }
            : { message: String(error) };

        const res = await this.pool.query(
            `INSERT INTO dead_letter_queue (task_id, step_id, error)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [taskId, stepId, JSON.stringify(errorObj)],
        );
        return res.rows[0];
    }

    async findByTaskId(taskId: string): Promise<DeadLetterQueueEntity[]> {
        const res = await this.pool.query(
            'SELECT * FROM dead_letter_queue WHERE task_id = $1 ORDER BY created_at ASC',
            [taskId],
        );
        return res.rows;
    }

    async findById(id: string): Promise<DeadLetterQueueEntity | null> {
        const res = await this.pool.query(
            'SELECT * FROM dead_letter_queue WHERE id = $1',
            [id],
        );
        return res.rows[0] || null;
    }

    async incrementRetryCount(id: string): Promise<void> {
        await this.pool.query(
            'UPDATE dead_letter_queue SET retry_count = retry_count + 1 WHERE id = $1',
            [id],
        );
    }

    async delete(id: string): Promise<void> {
        await this.pool.query('DELETE FROM dead_letter_queue WHERE id = $1', [id]);
    }
}
