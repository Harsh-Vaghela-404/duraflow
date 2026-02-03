import { Pool } from 'pg';
import { globalRegistry, WorkflowContext, StepRunner, StepOptions } from '@duraflow/sdk';
import { StepRepository } from '../repositories/step.repository';
import { TaskRepository } from '../repositories/task.repository';
import { TaskEntity, taskStatus } from '../db/task.entity';

export class WorkflowExecutor {
    private stepRepo: StepRepository;
    private taskRepo: TaskRepository;

    constructor(pool: Pool) {
        this.stepRepo = new StepRepository(pool);
        this.taskRepo = new TaskRepository(pool);
    }

    async execute(task: TaskEntity): Promise<unknown> {
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
                    return JSON.parse(existing.output as unknown as string) as T;
                }

                const step = await this.stepRepo.createOrFind(taskId, name, null);
                console.log(`[step] ${name} - executing`);

                try {
                    const result = await fn();
                    await this.stepRepo.updateCompleted(step.id, JSON.stringify(result));
                    return result;
                } catch (err) {
                    await this.stepRepo.updateFailed(step.id, String(err));
                    throw err;
                }
            }
        };
    }
}
