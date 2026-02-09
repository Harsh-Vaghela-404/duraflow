import { workflow } from '@duraflow/sdk';

// 1. CPU Intensive Workflow
// Simulates work by looping
workflow('cpu-intensive', async ({ step, input }) => {
    const { iterations } = input as { iterations: number };

    await step.run('heavy-calculation', async () => {
        let result = 0;
        for (let i = 0; i < (iterations || 1000000); i++) {
            result += Math.sqrt(i);
        }
        return { result };
    });
});

// 2. I/O Intensive Workflow
// Simulates API calls by sleeping
workflow('io-intensive', async ({ step, input }) => {
    const { duration } = input as { duration: number };

    await step.run('api-call-1', async () => {
        await new Promise(resolve => setTimeout(resolve, duration || 100));
        return { status: 'ok' };
    });

    await step.run('api-call-2', async () => {
        await new Promise(resolve => setTimeout(resolve, duration || 100));
        return { status: 'ok' };
    });
});

// 3. Flaky Workflow
// Simulates failures to test retries
let failureCount = 0;
workflow('flaky-workflow', async ({ step }) => {
    await step.run('flaky-step', async () => {
        // Fail 30% of the time, causing retries
        if (Math.random() < 0.3) {
            throw new Error(`Simulated failure`);
        }
        return { status: 'recovered' };
    }, { retries: 5 });
});

// 4. Long Running Workflow
// Multiple steps with dependencies
workflow('long-running', async ({ step }) => {
    const step1 = await step.run('step-1', async () => {
        return { value: 10 };
    });

    const step2 = await step.run('step-2', async () => {
        return { value: step1.value * 2 };
    });

    await step.run('step-3', async () => {
        return { final: step2.value + 5 };
    });
});
