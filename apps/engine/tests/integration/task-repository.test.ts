import { Pool } from 'pg';
import { TaskRepository } from '../../src/repositories/task.repository';
import { createTestPool, closePool, clearTables } from '../helpers/db';

describe('TaskRepository', () => {
    let pool: Pool;
    let repo: TaskRepository;

    beforeAll(async () => {
        pool = createTestPool();
        repo = new TaskRepository(pool);
    });

    afterAll(async () => {
        await closePool(pool);
    });

    beforeEach(async () => {
        await clearTables(pool);
    });

    it('creates a task', async () => {
        const task = await repo.create('test-wf', { foo: 'bar' });
        expect(task.id).toBeDefined();
        expect(task.status).toBe('pending');
        expect(task.input).toEqual({ foo: 'bar' });
    });

    it('finds a task by ID', async () => {
        const created = await repo.create('test-wf', {});
        const found = await repo.findById(created.id);
        expect(found).toBeDefined();
        expect(found?.id).toBe(created.id);
    });

    it('dequeues pending tasks', async () => {
        await repo.create('wf-1', {});
        await repo.create('wf-2', {});

        const dequeued = await repo.dequeue(10, 'worker-1');
        expect(dequeued).toHaveLength(2);
        const first = dequeued[0]!;
        expect(first).toBeDefined();
        expect(first.worker_id).toBe('worker-1');
        expect(first.status).toBe('running');
    });

    it('respects batch size', async () => {
        await repo.create('wf-1', { p: 1 });
        await repo.create('wf-2', { p: 2 });
        await repo.create('wf-3', { p: 3 });

        const batch1 = await repo.dequeue(2, 'worker-1');
        expect(batch1).toHaveLength(2);
    });
});
