import { StepRunner, StepOptions } from './types';

export interface StepClient {
    getStepResult(taskId: string, stepKey: string): Promise<{ found: boolean; status: string; output: string }>;
    createStep(taskId: string, stepKey: string): Promise<{ stepId: string }>;
    saveStepResult(taskId: string, stepKey: string, output: string): Promise<{ stepId: string }>;
    failStep(taskId: string, stepKey: string, error: string): Promise<void>;
}

export function createStepRunner(taskId: string, client: StepClient): StepRunner {
    return {
        async run<T>(name: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T> {
            const existing = await client.getStepResult(taskId, name);

            if (existing.found && existing.status === 'completed') {
                return JSON.parse(existing.output) as T;
            }

            await client.createStep(taskId, name);

            try {
                const result = await fn();
                await client.saveStepResult(taskId, name, JSON.stringify(result));
                return result;
            } catch (err) {
                await client.failStep(taskId, name, String(err));
                throw err;
            }
        }
    };
}