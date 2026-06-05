import { Pool } from 'pg';
import { Poller } from '../../src/services/poller';
import { TaskRepository } from '../../src/repositories/task.repository';
import { createTestPool, closePool, clearTables } from '../helpers/db';
import { sleep } from '../helpers/poll';

describe('Poller runtime isolation', () => {
    let pool: Pool;
    beforeAll(() => {
        pool = createTestPool();
    });
    afterAll(async () => {
        await closePool(pool);
    });
    beforeEach(async () => {
        await clearTables(pool);
    });

    it('internal node poller never claims python tasks', async () => {
        const repo = new TaskRepository(pool);
        const py = await repo.create('wf', {}, 'python');

        const received: string[] = [];
        const poller = new Poller(repo, {
            workerId: 'node-1',
            batchSize: 10,
            onTaskReceived: async (t) => {
                received.push(t.id);
            },
        });
        poller.start();
        await sleep(300);
        await poller.stop();

        expect(received).not.toContain(py.id);
        const after = await repo.findById(py.id);
        expect(after!.status).toBe('pending'); // untouched
    });
});
