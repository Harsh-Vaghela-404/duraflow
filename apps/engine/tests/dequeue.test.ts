import { pool } from '../src/db';
import { TaskRepository } from '../src/repositories/task.repository';
import { taskStatus } from '../src/db/task.entity';

describe('Dequeue functionality', () => {
    let taskRepo: TaskRepository;

    beforeAll(() => {
        taskRepo = new TaskRepository(pool);
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM agent_tasks WHERE workflow_name LIKE 'test-%' OR workflow_name LIKE 'concurrent-%' OR workflow_name LIKE 'batch-%' OR workflow_name LIKE 'already-running' OR workflow_name LIKE 'pending-task'");
    });

    afterAll(async () => {
        await pool.query("DELETE FROM agent_tasks WHERE workflow_name LIKE 'test-%' OR workflow_name LIKE 'concurrent-%' OR workflow_name LIKE 'batch-%' OR workflow_name LIKE 'already-running' OR workflow_name LIKE 'pending-task'");
        await pool.end();
    });

    it('should dequeue tasks with correct status and worker assignment', async () => {
        for (let i = 0; i < 5; i++) {
            await taskRepo.create(`test-workflow-${i}`, { test: true, index: i });
        }

        const tasks = await taskRepo.dequeue(3, 'worker-1');

        expect(tasks).toHaveLength(3);
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks[0]!.status).toBe(taskStatus.RUNNING);
        expect(tasks[0]!.worker_id).toBe('worker-1');
        expect(tasks[0]!.heartbeat_at).toBeDefined();
    });

    it('should handle concurrent dequeue without duplicates', async () => {
        for (let i = 0; i < 10; i++) {
            await taskRepo.create(`concurrent-test-${i}`, { test: true });
        }

        const [worker1Tasks, worker2Tasks] = await Promise.all([
            taskRepo.dequeue(5, 'worker-1'),
            taskRepo.dequeue(5, 'worker-2')
        ]);

        const totalTasks = worker1Tasks.length + worker2Tasks.length;
        expect(totalTasks).toBe(10);

        const allIds = [...worker1Tasks, ...worker2Tasks].map(t => t.id);
        const uniqueIds = new Set(allIds);
        expect(allIds.length).toBe(uniqueIds.size);

        worker1Tasks.forEach(task => {
            expect(task.worker_id).toBe('worker-1');
            expect(task.status).toBe(taskStatus.RUNNING);
        });

        worker2Tasks.forEach(task => {
            expect(task.worker_id).toBe('worker-2');
            expect(task.status).toBe(taskStatus.RUNNING);
        });
    });

    it('should return empty array when queue is empty', async () => {
        const emptyResult = await taskRepo.dequeue(10, 'worker-3');
        expect(emptyResult).toEqual([]);
    });

    it('should respect batch size limit', async () => {
        for (let i = 0; i < 10; i++) {
            await taskRepo.create(`batch-test-${i}`, { test: true });
        }

        const tasks = await taskRepo.dequeue(3, 'worker-batch');

        expect(tasks).toHaveLength(3);
    });

    it('should only dequeue pending tasks', async () => {
        const task1 = await taskRepo.create('already-running', { test: true });
        await taskRepo.updateStatus(task1.id, taskStatus.RUNNING);

        await taskRepo.create('pending-task', { test: true });

        const tasks = await taskRepo.dequeue(10, 'worker-status');

        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.workflow_name).toBe('pending-task');
    });
});
