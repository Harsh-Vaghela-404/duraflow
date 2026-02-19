import { Pool } from 'pg';
import path from 'path';
import { createPiscinaPool, WorkflowExecutor } from '../../src/services/workflow-executor';
import { createTestPool, closePool, clearTables, createTask, getTask } from '../helpers/db';
import { sleep } from '../helpers/poll';

describe('WorkflowExecutor Integration', () => {
    let pool: Pool;
    let piscina: any;
    let executor: WorkflowExecutor;

    beforeAll(async () => {
        pool = createTestPool();
        // Point DURAFLOW_WORKFLOWS to our test file
        process.env.DURAFLOW_WORKFLOWS = path.resolve(__dirname, '../workflows/test-workflows.ts');
        piscina = createPiscinaPool();
        executor = new WorkflowExecutor(pool, piscina);
    });

    afterAll(async () => {
        await executor.destroy();
        await closePool(pool);
    });

    beforeEach(async () => {
        await clearTables(pool);
    });

    it('executes a simple workflow end-to-end', async () => {
        const task = await createTask(pool, 'simple-wf', { hello: 'world' });

        await executor.execute(task);

        const result = await getTask(pool, task.id);
        expect(result.status).toBe('completed');
        expect(result.output).toEqual({ result: { processed: { hello: 'world' } } });
    });

    it('handles workflow failure', async () => {
        const task = await createTask(pool, 'failing-wf', {});

        await expect(executor.execute(task)).rejects.toThrow('Task failed successfully');

        const result = await getTask(pool, task.id);
        expect(result.status).toBe('failed');
        expect(result.error).toBeDefined();
    });
});
