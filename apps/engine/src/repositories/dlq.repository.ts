import { Pool } from "pg";
import { DeadLetterQueueEntity } from "../db/dead_letter_queue.entity";
import { StepRepository } from "./step.repository";
import { compensationRegistry } from "@duraflow/sdk";

export class DeadLetterQueueRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    taskId: string,
    stepId: string,
    error: unknown,
  ): Promise<DeadLetterQueueEntity> {
    const errorObj =
      error instanceof Error
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
      "SELECT * FROM dead_letter_queue WHERE task_id = $1 ORDER BY created_at ASC",
      [taskId],
    );
    return res.rows;
  }

  async findById(id: string): Promise<DeadLetterQueueEntity | null> {
    const res = await this.pool.query(
      "SELECT * FROM dead_letter_queue WHERE id = $1",
      [id],
    );
    return res.rows[0] || null;
  }

  async incrementRetryCount(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE dead_letter_queue SET retry_count = retry_count + 1 WHERE id = $1",
      [id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query("DELETE FROM dead_letter_queue WHERE id = $1", [id]);
  }

  async findAll(limit = 100, offset = 0): Promise<DeadLetterQueueEntity[]> {
    const res = await this.pool.query(
      "SELECT * FROM dead_letter_queue ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    );
    return res.rows;
  }

  async countAll(): Promise<number> {
    const res = await this.pool.query(
      "SELECT COUNT(*) as count FROM dead_letter_queue",
    );
    return parseInt(res.rows[0].count, 10);
  }

  async retry(id: string): Promise<{ success: boolean; error?: string }> {
    const item = await this.findById(id);
    if (!item) {
      return { success: false, error: "DLQ item not found" };
    }

    const stepRepo = new StepRepository(this.pool);
    const step = await stepRepo.findById(item.step_id);

    if (!step || !step.compensation_fn) {
      return {
        success: false,
        error: "Step or compensation function not found",
      };
    }

    const compensationFn = compensationRegistry.get(step.compensation_fn);
    if (!compensationFn) {
      return {
        success: false,
        error: `Compensation function "${step.compensation_fn}" not found in registry`,
      };
    }

    try {
      await compensationFn(step.output);
      await this.delete(id);
      return { success: true };
    } catch (err) {
      await this.incrementRetryCount(id);
      const errorObj = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorObj };
    }
  }
}
