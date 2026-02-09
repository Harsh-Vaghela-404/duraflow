import { workflow } from '@duraflow/sdk';

let failCount = 0;

workflow('worker-thread-test', async ({ step, input }) => {
    const { value, shouldFail } = input as { value?: number; shouldFail?: number };

    const processResult = await step.run('process', async () => {
        return { processed: true, value: value || 0 };
    });

    if (shouldFail && shouldFail > 0) {
        const flakyResult = await step.run('flaky-step', async () => {
            failCount++;
            if (failCount < shouldFail) {
                throw new Error(`Simulated failure ${failCount}/${shouldFail}`);
            }
            return { recovered: true, attempts: failCount };
        }, { retries: 5 });

        return { ...processResult, ...flakyResult };
    }

    return processResult;
});
