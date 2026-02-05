import { workflow } from '@duraflow/sdk';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export const crashTestWorkflow = workflow('crash-test', async (ctx) => {
    const results: string[] = [];

    // Helper to perform a trackable step
    const performStep = async (stepNum: number) => {
        return await ctx.step.run(`step-${stepNum}`, async () => {
            console.log(`Executing Step ${stepNum}`);

            // Side effect: Increment Redis counter
            await redis.incr(`crash-test:step-${stepNum}`);

            return `result-${stepNum}`;
        });
    };

    // Execute 5 sequential steps
    for (let i = 1; i <= 5; i++) {
        const res = await performStep(i);
        results.push(res);

        // Check for simulated crash AFTER step completion (so it gets checkpointed)
        const crashTarget = process.env.CRASH_AFTER_STEP;
        if (crashTarget && parseInt(crashTarget) === i) {
            console.log(`💥 CRASHING after Step ${i} as requested!`);
            process.exit(1);
        }
    }

    return {
        status: 'completed',
        results
    };
});
