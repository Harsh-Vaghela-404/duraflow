import { Pool } from 'pg';
import { StepRepository } from '../../src/repositories/step.repository';
import { createTestPool, closePool, clearTables, createTask } from '../helpers/db';

describe('StepRepository', () => {
    let pool: Pool;
    let stepRepo: StepRepository;
    let taskId: string;

    beforeAll(async () => {
        pool = createTestPool();
        stepRepo = new StepRepository(pool);
    });

    afterAll(async () => {
        await closePool(pool);
    });

    beforeEach(async () => {
        await clearTables(pool);
        const task = await createTask(pool, 'test-wf');
        taskId = task.id;
    });

    it('createOrFind creates a new step', async () => {
        const step = await stepRepo.createOrFind(taskId, 'step-1', { a: 1 });
        expect(step.id).toBeDefined();
        expect(step.step_key).toBe('step-1');
        expect(step.status).toBe('pending');
    });

    it('createOrFind returns existing step on conflict', async () => {
        const step1 = await stepRepo.createOrFind(taskId, 'step-1', {});
        const step2 = await stepRepo.createOrFind(taskId, 'step-1', {});

        expect(step1.id).toBe(step2.id);
    });

    it('updates completion status', async () => {
        const step = await stepRepo.createOrFind(taskId, 'step-1', {});
        await stepRepo.updateCompleted(step.id, { result: 42 });

        const updated = await stepRepo.findByTaskAndKey(taskId, 'step-1');
        expect(updated?.status).toBe('completed');
        expect(updated?.output).toEqual({ result: 42 });
    });
});
