import { workflow } from '@duraflow/sdk';

// Example workflow for local dev
export const helloWorld = workflow('hello-world', async ({ step, input }) => {
    const greeting = await step.run('greet', async () => {
        return `Hello, ${(input as any).name || 'World'}!`;
    });
    return { message: greeting };
});
