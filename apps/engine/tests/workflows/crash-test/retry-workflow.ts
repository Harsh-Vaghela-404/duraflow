import { workflow } from '@duraflow/sdk';

let attempts = 0;

workflow('retry-test', async ({ step }) => {
    // Step 1: Always succeeds
    const startResult = await step.run('start', async () => {
        return { message: 'started' };
    });

    // Step 2: Fails twice, succeeds on 3rd attempt
    // We expect the worker to suspend and be rescheduled between attempts
    const processed = await step.run('process', async () => {
        attempts++;
        if (attempts < 3) {
            throw new Error(`Simulated failure attempt ${attempts}`);
        }
        return { message: 'processed', attempts };
    }, { retries: 5 });

    return {
        start: startResult,
        process: processed
    };
});
