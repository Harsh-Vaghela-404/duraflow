import { Pool } from "pg";
import { DeadLetterQueueEntity } from "../db/dead_letter_queue.entity";
import { StepRepository } from "./step.repository";
import { compensationRegistry } from "@duraflow/sdk";
import { taskStatus } from "../db/task.entity";

export class DeadLetterQueueRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    taskId: string,
    stepId: string,
    error: unknown,
  ): Promise<DeadLetterQueueEntity> {
    // RollbackOrchestrator passes a rich plain-object error context — keep it as-is
    // so operators get the full taskId/stepId/stepKey/compensationFn breadcrumb.
    // Wrap primitives and stringify-only values into a minimal { message } envelope.
    const errorObj =
      error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : typeof error === "object" && error !== null
          ? error
          : { message: String(error) };

    const res = await this.pool.query(
      `INSERT INTO dead_letter_queue (task_id, step_id, error)
             VALUES ($1, $2, $3)
             RETURNING *`,
      [taskId, stepId, errorObj],
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
      await stepRepo.markCompensated(item.step_id);
      await this.delete(id);

      // If this was the last unresolved DLQ entry for the task, the saga is now
      // fully compensated — transition partial_rollback → rolled_back so the task's
      // terminal status reflects reality.
      const remaining = await this.findByTaskId(item.task_id);
      if (remaining.length === 0) {
        await this.pool.query(
          `UPDATE agent_tasks SET status = $1 WHERE id = $2 AND status = $3`,
          [taskStatus.ROLLED_BACK, item.task_id, taskStatus.PARTIAL_ROLLBACK],
        );
      }

      return { success: true };
    } catch (err) {
      await this.incrementRetryCount(id);
      const errorObj = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorObj };
    }
  }
}
