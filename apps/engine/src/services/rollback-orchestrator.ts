import { Pool } from "pg";
import { compensationRegistry } from "@duraflow/sdk";
import { StepRepository } from "../repositories/step.repository";
import { TaskRepository } from "../repositories/task.repository";
import { DeadLetterQueueRepository } from "../repositories/dlq.repository";
import { taskStatus } from "../db/task.entity";

const TAG = "[rollback]";

const DEFAULT_COMPENSATION_TIMEOUT_MS = 30000;

export interface RollbackOptions {
  compensationTimeoutMs?: number;
}

export interface RollbackResult {
  taskId: string;
  totalSteps: number;
  compensated: number;
  failed: number;
  finalStatus: taskStatus.ROLLED_BACK | taskStatus.PARTIAL_ROLLBACK;
}

export class RollbackOrchestrator {
  private stepRepo: StepRepository;
  private taskRepo: TaskRepository;
  private dlqRepo: DeadLetterQueueRepository;
  private defaultTimeout: number;

  constructor(pool: Pool, options?: { compensationTimeoutMs?: number }) {
    this.stepRepo = new StepRepository(pool);
    this.taskRepo = new TaskRepository(pool);
    this.dlqRepo = new DeadLetterQueueRepository(pool);
    this.defaultTimeout =
      options?.compensationTimeoutMs ?? DEFAULT_COMPENSATION_TIMEOUT_MS;
  }

  async rollback(
    taskId: string,
    options?: RollbackOptions,
  ): Promise<RollbackResult> {
    const timeoutMs = options?.compensationTimeoutMs ?? this.defaultTimeout;
    const steps = await this.stepRepo.findCompletedWithCompensation(taskId);

    if (steps.length === 0) {
      console.log(`${TAG} task ${taskId} — no compensatable steps found`);
      await this.taskRepo.updateStatus(taskId, taskStatus.ROLLED_BACK);
      return {
        taskId,
        totalSteps: 0,
        compensated: 0,
        failed: 0,
        finalStatus: taskStatus.ROLLED_BACK,
      };
    }

    console.log(
      `${TAG} task ${taskId} — rolling back ${steps.length} steps (LIFO)`,
    );
    let compensated = 0;
    let failed = 0;

    for (const step of steps) {
      const fnName = step.compensation_fn!;
      const fn = compensationRegistry.get(fnName);

      if (!fn) {
        const errorContext = {
          taskId,
          stepId: step.id,
          stepKey: step.step_key,
          compensationFn: fnName,
          error: {
            message: `Compensation function "${fnName}" not found in registry`,
          },
        };
        console.error(
          `${TAG} step ${step.id} — compensation "${fnName}" not found in registry:`,
          errorContext,
        );
        await this.dlqRepo.insert(taskId, step.id, errorContext);
        failed++;
        continue;
      }

      try {
        await this.executeWithTimeout(fn, step.output, timeoutMs);
        await this.stepRepo.markCompensated(step.id);
        compensated++;
        console.log(`${TAG} step ${step.id} (${step.step_key}) — compensated`);
      } catch (err) {
        const isTimeout =
          err instanceof Error && err.message === "Compensation timeout";
        const errorContext = {
          taskId,
          stepId: step.id,
          stepKey: step.step_key,
          compensationFn: fnName,
          stepOutput: step.output,
          error: isTimeout
            ? {
                message: `Compensation timed out after ${timeoutMs}ms`,
                name: "TimeoutError",
              }
            : err instanceof Error
              ? { message: err.message, name: err.name, stack: err.stack }
              : String(err),
        };
        console.error(
          `${TAG} failed to compensate step ${step.id} (${step.step_key}):`,
          errorContext,
        );
        await this.dlqRepo.insert(taskId, step.id, errorContext);
        failed++;
      }
    }

    const finalStatus =
      failed > 0 ? taskStatus.PARTIAL_ROLLBACK : taskStatus.ROLLED_BACK;
    await this.taskRepo.updateStatus(taskId, finalStatus);
    console.log(
      `${TAG} task ${taskId} — ${finalStatus} (${compensated}/${steps.length} compensated, ${failed} failed)`,
    );

    return {
      taskId,
      totalSteps: steps.length,
      compensated,
      failed,
      finalStatus,
    };
  }

  private async executeWithTimeout<T>(
    fn: (output: unknown) => Promise<T>,
    output: unknown,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Compensation timeout"));
      }, timeoutMs);

      fn(output)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
