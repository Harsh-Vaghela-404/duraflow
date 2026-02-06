import { Pool } from 'pg';
import { globalRegistry, WorkflowContext, StepRunner, StepOptions, serialize, deserialize } from '@duraflow/sdk';
import { StepRepository } from '../repositories/step.repository';
import { TaskRepository } from '../repositories/task.repository';
import { TaskEntity } from '../db/task.entity';
import { calculateBackOff } from "../utils/backoff";
import { StepRetryError } from '../errors/step-retry.error';

export class WorkflowExecutor {
    private stepRepo: StepRepository;
    private taskRepo: TaskRepository;

    constructor(pool: Pool) {
        this.stepRepo = new StepRepository(pool);
        this.taskRepo = new TaskRepository(pool);
    }

    async execute(task: TaskEntity): Promise<unknown> {
        console.error(`[executor] Task ${task.id} started`);
        const workflow = globalRegistry.get(task.workflow_name);
        if (!workflow) {
            await this.taskRepo.fail(task.id, new Error(`Workflow "${task.workflow_name}" not found in registry`));
            throw new Error(`Workflow "${task.workflow_name}" not found in registry`);
        }

        const stepRunner = this.createStepRunner(task.id);

        const ctx: WorkflowContext = {
            runId: task.id,
            workflowName: task.workflow_name,
            input: task.input,
            step: stepRunner
        };

        try {
            const result = await workflow.handler(ctx);
            await this.taskRepo.updateCompleted(task.id, result);
            return result;
        } catch (err) {
            if (err instanceof StepRetryError) {
                console.log(
                    `[executor] Task ${task.id} suspended for step retry. Resuming in ${err.delay}ms`
                );
                await this.taskRepo.scheduleRetry(task.id, err.delay, task.retry_count, err.originalError);
                return;
            }

            console.error(`[executor] Task ${task.id} failed:`, err);
            await this.taskRepo.fail(task.id, err);
            throw err;
        }
    }

    private createStepRunner(taskId: string): StepRunner {
        return {
            run: async <T>(name: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T> => {
                const existing = await this.stepRepo.findByTaskAndKey(taskId, name);

                if (existing?.status === 'completed') {
                    console.log(`[step] ${name} - cache hit`);
                    const outputStr = JSON.stringify(existing.output);
                    return deserialize(outputStr) as T;
                }

                const step = await this.stepRepo.createOrFind(taskId, name, null);
                // Respect persisted attempt count if any, else 1
                const currentAttempt = step.attempt || 1;
                console.log(`[step] ${name} - executing (attempt ${currentAttempt})`);

                try {
                    const result = await fn();
                    const serializedStr = serialize(result);
                    await this.stepRepo.updateCompleted(step.id, JSON.parse(serializedStr));
                    return result;
                } catch (err) {
                    const maxRetries = opts?.retries ?? 0;
                    console.error(`[step] ${name} failed (attempt ${currentAttempt}/${maxRetries + 1}):`, err);

                    if (currentAttempt <= maxRetries) {
                        const delay = calculateBackOff(currentAttempt);
                        await this.stepRepo.incrementAttempt(step.id);

                        throw new StepRetryError(delay, currentAttempt + 1, err);
                    }

                    await this.stepRepo.updateFailed(step.id, String(err));
                    throw err;
                }
            }
        };
    }
}
