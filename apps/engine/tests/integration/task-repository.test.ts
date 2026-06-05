import { Pool } from 'pg';
import { TaskRepository } from '../../src/repositories/task.repository';
import { taskStatus } from '../../src/db/task.entity';
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

    describe('runtime routing', () => {
        it('create() defaults runtime to node', async () => {
            const task = await repo.create('wf', {});
            expect(task.runtime).toBe('node');
        });

        it('create() persists an explicit python runtime', async () => {
            const task = await repo.create('wf', {}, 'python');
            expect(task.runtime).toBe('python');
        });

        it('dequeue() only claims rows matching the requested runtime', async () => {
            await repo.create('wf', {}, 'node');
            const py = await repo.create('wf', {}, 'python');

            const claimed = await repo.dequeue(10, 'worker-1', 'python');
            expect(claimed.map((t) => t.id)).toEqual([py.id]);
            expect(claimed[0]!.status).toBe(taskStatus.RUNNING);
        });
    });

    describe('task-level complete/fail guards', () => {
        it('completeRunning marks a running task completed and returns true', async () => {
            const task = await repo.create('wf', {}, 'python');
            await repo.dequeue(10, 'w1', 'python'); // -> running
            const ok = await repo.completeRunning(task.id, { result: 42 });
            expect(ok).toBe(true);
            const after = await repo.findById(task.id);
            expect(after!.status).toBe(taskStatus.COMPLETED);
            expect(after!.output).toEqual({ result: 42 });
        });

        it('completeRunning returns false for a non-running task', async () => {
            const task = await repo.create('wf', {}, 'python'); // still pending
            const ok = await repo.completeRunning(task.id, { result: 1 });
            expect(ok).toBe(false);
        });

        it('failRunning marks a running task failed and returns true', async () => {
            const task = await repo.create('wf', {}, 'python');
            await repo.dequeue(10, 'w1', 'python');
            const ok = await repo.failRunning(task.id, { message: 'boom', name: 'Error' });
            expect(ok).toBe(true);
            const after = await repo.findById(task.id);
            expect(after!.status).toBe(taskStatus.FAILED);
            expect(after!.error).toEqual({ message: 'boom', name: 'Error' });
        });
    });
});
