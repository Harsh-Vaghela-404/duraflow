import { Pool } from "pg";
import { StepRunsEntity, stepStatus } from "../db/step_runs.entity";

/**
 * Repository for managing workflow step executions.
 * Steps are memoized to enable crash recovery and replay.
 */
export class StepRepository {
    constructor(private pool: Pool) { }

    /**
     * Creates a new step execution record.
     * @param taskId Parent task UUID
     * @param stepKey Unique identifier for this step within the workflow
     * @param input Input data for the step
     * @returns The created step entity
     */
    async create(taskId: string, stepKey: string, input: unknown): Promise<StepRunsEntity> {
        const res = await this.pool.query(
            'INSERT INTO step_runs (task_id, step_key, input) VALUES($1, $2, $3) RETURNING *',
            [taskId, stepKey, input]
        );
        return res?.rows[0];
    }

    /**
     * Finds the most recent execution of a step within a task.
     * Used for memoization: if step already completed, return cached result.
     * @param taskId Parent task UUID
     * @param stepKey Step identifier
     * @returns Most recent step execution, or null if not found
     */
    async findByTaskAndKey(taskId: string, stepKey: string): Promise<StepRunsEntity | null> {
        const res = await this.pool.query(
            'SELECT * FROM step_runs WHERE task_id = $1 AND step_key = $2 ORDER BY created_at DESC',
            [taskId, stepKey]
        );
        return res?.rows[0];
    }

    /**
     * Marks a step as successfully completed and stores its output.
     * @param id Step UUID
     * @param output Result data from the step execution
     */
    async updateCompleted(id: string, output: unknown): Promise<void> {
        await this.pool.query(
            'UPDATE step_runs SET output = $1, status = $2, completed_at = NOW() WHERE id = $3',
            [output, stepStatus.COMPLETED, id]
        );
    }

    /**
     * Marks a step as failed and stores the error details.
     * @param id Step UUID
     * @param error Error information from the failed execution
     */
    async updateFailed(id: string, error: unknown): Promise<void> {
        await this.pool.query(
            'UPDATE step_runs SET error = $1, status = $2 WHERE id = $3',
            [error, stepStatus.FAILED, id]
        );
    }

    /**
     * Retrieves all steps for a task, ordered chronologically.
     * Used for debugging and workflow visualization.
     * @param taskId Parent task UUID
     * @returns Array of step executions
     */
    async findByTaskId(taskId: string): Promise<StepRunsEntity[]> {
        const res = await this.pool.query(
            'SELECT * FROM step_runs WHERE task_id = $1 ORDER BY created_at ASC',
            [taskId]
        );
        return res?.rows;
    }
}