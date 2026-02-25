import { Pool } from 'pg';
import { compensationRegistry } from '@duraflow/sdk';
import { StepRepository } from '../repositories/step.repository';
import { TaskRepository } from '../repositories/task.repository';
import { DeadLetterQueueRepository } from '../repositories/dlq.repository';
import { taskStatus } from '../db/task.entity';

const TAG = '[rollback]';

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

    constructor(pool: Pool) {
        this.stepRepo = new StepRepository(pool);
        this.taskRepo = new TaskRepository(pool);
        this.dlqRepo = new DeadLetterQueueRepository(pool);
    }

    async rollback(taskId: string): Promise<RollbackResult> {
        const steps = await this.stepRepo.findCompletedWithCompensation(taskId);

        if (steps.length === 0) {
            console.log(`${TAG} task ${taskId} — no compensatable steps found`);
            await this.taskRepo.updateStatus(taskId, taskStatus.ROLLED_BACK);
            return { taskId, totalSteps: 0, compensated: 0, failed: 0, finalStatus: taskStatus.ROLLED_BACK };
        }

        console.log(`${TAG} task ${taskId} — rolling back ${steps.length} steps (LIFO)`);
        let compensated = 0;
        let failed = 0;

        for (const step of steps) {
            const fnName = step.compensation_fn!;
            const fn = compensationRegistry.get(fnName);

            if (!fn) {
                console.error(`${TAG} step ${step.id} — compensation "${fnName}" not found in registry`);
                await this.dlqRepo.insert(taskId, step.id, { message: `Compensation function "${fnName}" not found in registry` });
                failed++;
                continue;
            }

            try {
                await fn(step.output);
                await this.stepRepo.markCompensated(step.id);
                compensated++;
                console.log(`${TAG} step ${step.id} (${step.step_key}) — compensated`);
            } catch (err) {
                console.error(`${TAG} step ${step.id} (${step.step_key}) — compensation failed:`, err);
                await this.dlqRepo.insert(taskId, step.id, err);
                failed++;
            }
        }

        const finalStatus = failed > 0 ? taskStatus.PARTIAL_ROLLBACK : taskStatus.ROLLED_BACK;
        await this.taskRepo.updateStatus(taskId, finalStatus);
        console.log(`${TAG} task ${taskId} — ${finalStatus} (${compensated}/${steps.length} compensated, ${failed} failed)`);

        return { taskId, totalSteps: steps.length, compensated, failed, finalStatus };
    }
}
