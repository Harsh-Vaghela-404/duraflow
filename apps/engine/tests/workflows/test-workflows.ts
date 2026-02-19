import { workflow } from '@duraflow/sdk';

export const simpleWorkflow = workflow('simple-wf', async ({ step, input }) => {
    const res = await step.run('step-1', async () => {
        return { processed: input };
    });
    return { result: res };
});

export const failingWorkflow = workflow('failing-wf', async ({ step }) => {
    await step.run('step-1', async () => {
        throw new Error('Task failed successfully');
    });
});
