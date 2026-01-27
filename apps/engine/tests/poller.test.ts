import { pool } from '../src/db';
import { TaskRepository } from '../src/repositories/task.repository';
import { TaskEntity, taskStatus } from '../src/db/task.entity';
import { Poller } from '../src/services/poller';

describe('Poller', () => {
    let taskRepo: TaskRepository;

    beforeAll(() => {
        taskRepo = new TaskRepository(pool);
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM agent_tasks WHERE workflow_name LIKE 'poller-test-%'");
    });

    afterAll(async () => {
        await pool.query("DELETE FROM agent_tasks WHERE workflow_name LIKE 'poller-test-%'");
        await pool.end();
    });

    it('should pick up tasks and call the callback', async () => {
        // Create a test task
        await taskRepo.create('poller-test-workflow', { data: 'test' });

        const receivedTasks: TaskEntity[] = [];
        const poller = new Poller(
            taskRepo,
            'test-worker-1',
            async (task) => {
                receivedTasks.push(task);
            },
            10
        );

        poller.start();

        await new Promise((resolve) => setTimeout(resolve, 300));

        await poller.stop();

        expect(receivedTasks.length).toBe(1);
        expect(receivedTasks[0]!.workflow_name).toBe('poller-test-workflow');
        expect(receivedTasks[0]!.status).toBe(taskStatus.RUNNING);
        expect(receivedTasks[0]!.worker_id).toBe('test-worker-1');
    });

    it('should return empty when no tasks available', async () => {
        const receivedTasks: TaskEntity[] = [];
        const poller = new Poller(
            taskRepo,
            'test-worker-2',
            async (task) => {
                receivedTasks.push(task);
            }
        );

        poller.start();

        await new Promise((resolve) => setTimeout(resolve, 500));

        await poller.stop();

        expect(receivedTasks.length).toBe(0);
    });

    it('should not pick up already running tasks', async () => {
        const task = await taskRepo.create('poller-test-running', { data: 'test' });
        await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

        const receivedTasks: TaskEntity[] = [];
        const poller = new Poller(
            taskRepo,
            'test-worker-3',
            async (t) => {
                receivedTasks.push(t);
            }
        );

        poller.start();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await poller.stop();

        expect(receivedTasks.length).toBe(0);
    });

    it('should process multiple tasks', async () => {
        for (let i = 0; i < 5; i++) {
            await taskRepo.create(`poller-test-batch-${i}`, { index: i });
        }

        const receivedTasks: TaskEntity[] = [];
        const poller = new Poller(
            taskRepo,
            'test-worker-4',
            async (task) => {
                receivedTasks.push(task);
            },
            10
        );

        poller.start();
        await new Promise((resolve) => setTimeout(resolve, 500));
        await poller.stop();

        expect(receivedTasks.length).toBe(5);
    });
});
