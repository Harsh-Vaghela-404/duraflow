import { Pool } from "pg";
import { StepRunsEntity, stepStatus } from "../db/step_runs.entity";

export class StepRepository {
    constructor(private pool: Pool) { }

    async create(taskId: string, stepKey: string, input: unknown): Promise<StepRunsEntity> {
        const res = await this.pool.query(
            'INSERT INTO step_runs (task_id, step_key, input) VALUES($1, $2, $3) RETURNING *',
            [taskId, stepKey, input]
        );
        return res?.rows[0];
    }

    async createOrFind(taskId: string, stepKey: string, input: unknown): Promise<StepRunsEntity> {
        const existing = await this.findByTaskAndKey(taskId, stepKey);
        if (existing) {
            return existing;
        }

        try {
            return await this.create(taskId, stepKey, input);
        } catch (err: any) {
            if (err.code === '23505') {
                const existingAfterConflict = await this.findByTaskAndKey(taskId, stepKey);
                if (existingAfterConflict) return existingAfterConflict;
            }
            throw err;
        }
    }

    async findByTaskAndKey(taskId: string, stepKey: string): Promise<StepRunsEntity | null> {
        const res = await this.pool.query(
            'SELECT * FROM step_runs WHERE task_id = $1 AND step_key = $2 ORDER BY created_at DESC',
            [taskId, stepKey]
        );
        return res?.rows[0];
    }

    async updateCompleted(id: string, output: unknown): Promise<void> {
        await this.pool.query(
            'UPDATE step_runs SET output = $1, status = $2, completed_at = NOW() WHERE id = $3',
            [output, stepStatus.COMPLETED, id]
        );
    }

    async updateFailed(id: string, error: unknown): Promise<void> {
        await this.pool.query(
            'UPDATE step_runs SET error = $1, status = $2 WHERE id = $3',
            [error, stepStatus.FAILED, id]
        );
    }

    async findByTaskId(taskId: string): Promise<StepRunsEntity[]> {
        const res = await this.pool.query(
            'SELECT * FROM step_runs WHERE task_id = $1 ORDER BY created_at ASC',
            [taskId]
        );
        return res?.rows;
    }
}