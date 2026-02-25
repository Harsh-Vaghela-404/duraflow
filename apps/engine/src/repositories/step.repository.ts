import { Pool } from 'pg';
import { StepRunsEntity, stepStatus } from '../db/step_runs.entity';

export class StepRepository {
    constructor(private readonly pool: Pool) { }

    async createOrFind(taskId: string, stepKey: string, input: unknown): Promise<StepRunsEntity> {
        // Single upsert — avoids the SELECT + INSERT round-trip on the happy path
        const res = await this.pool.query(
            `INSERT INTO step_runs (task_id, step_key, input, started_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (task_id, step_key) DO NOTHING
             RETURNING *`,
            [taskId, stepKey, input],
        );

        if (res.rows[0]) return res.rows[0];

        // Conflict: another thread created it first, fetch and return it
        const existing = await this.findByTaskAndKey(taskId, stepKey);
        if (existing) return existing;
        throw new Error(`Step (${taskId}, ${stepKey}) vanished after conflict`);
    }

    async findByTaskAndKey(taskId: string, stepKey: string): Promise<StepRunsEntity | null> {
        // UNIQUE(task_id, step_key) guarantees at most one row — no ORDER BY needed
        const res = await this.pool.query(
            'SELECT * FROM step_runs WHERE task_id = $1 AND step_key = $2',
            [taskId, stepKey],
        );
        return res.rows[0] || null;
    }

    async updateCompleted(id: string, output: unknown, compensationFn?: string): Promise<void> {
        await this.pool.query(
            `UPDATE step_runs
             SET output = $1, status = $2, completed_at = NOW(), compensation_fn = $4
             WHERE id = $3`,
            [output, stepStatus.COMPLETED, id, compensationFn ?? null],
        );
    }

    async updateFailed(id: string, error: unknown): Promise<void> {
        await this.pool.query(
            'UPDATE step_runs SET error = $1, status = $2 WHERE id = $3',
            [error, stepStatus.FAILED, id],
        );
    }

    async incrementAttempt(id: string): Promise<void> {
        await this.pool.query('UPDATE step_runs SET attempt = attempt + 1 WHERE id = $1', [id]);
    }

    async findByTaskId(taskId: string): Promise<StepRunsEntity[]> {
        const res = await this.pool.query(
            'SELECT * FROM step_runs WHERE task_id = $1 ORDER BY created_at ASC',
            [taskId],
        );
        return res.rows;
    }
}