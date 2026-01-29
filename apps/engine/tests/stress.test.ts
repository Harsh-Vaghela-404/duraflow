import { pool } from "../src/db";
import { taskStatus } from "../src/db/task.entity";
import { TaskRepository } from "../src/repositories/task.repository"

const MAX_TASKS = 10000;
const TASKS_BATCH = 10;
const MAX_WORKERS = 50;

describe('Stress Test: Worker Flow', () => {
    const taskRepo: TaskRepository = new TaskRepository(pool)
    beforeAll(async () => {
        await pool.query(`DELETE FROM agent_tasks`);

        const BATCH_SIZE = 100;
        for (let batch = 0; batch < MAX_TASKS / BATCH_SIZE; batch++) {
            const taskPromises = [];
            for (let i = 0; i < BATCH_SIZE; i++) {
                const taskNum = batch * BATCH_SIZE + i;
                taskPromises.push(taskRepo.create(`Stress_Task${taskNum}`, { index: taskNum }));
            }
            await Promise.all(taskPromises);
        }

        const totalTasks = await pool.query(`SELECT COUNT(*) FROM agent_tasks`);
        console.log(`Stress Test: Current Task Count ${totalTasks.rows[0].count}`);
    }, 120000);

    afterAll(async () => {
        await pool.end();
    })

    it('Verify Task Execution', async () => {
        const processedIds: Set<string> = new Set();
        const duplicateTaskIds: string[] = [];

        async function worker(workerId: string): Promise<number> {
            let completed = 0
            while (true) {
                const tasks = await taskRepo.dequeue(TASKS_BATCH, workerId)

                if (!tasks.length) break;

                for (let task of tasks) {
                    if (processedIds.has(task.id)) {
                        duplicateTaskIds.push(task.id);
                    } else {
                        processedIds.add(task.id)
                        await taskRepo.updateStatus(task.id, taskStatus.COMPLETED)
                        completed++;
                    }
                }
            }
            return completed
        }

        const workerPromises = [];
        for (let i = 0; i < MAX_WORKERS; i++) {
            workerPromises.push(worker(`worker-${i}`))
        }

        const result = await Promise.all(workerPromises);
        const totalTaskCompleted = result.reduce((sum, count) => sum + count, 0);

        const totalCompletedTaskDB = await pool.query(
            `SELECT COUNT(*) FROM agent_tasks WHERE status = $1 AND workflow_name LIKE 'Stress_Task%'`,
            [taskStatus.COMPLETED]
        );

        console.log(`duplicateTaskIds.length`, duplicateTaskIds.length);
        console.log(`processedIds.size`, processedIds.size);
        console.log(`totalTaskCompleted`, totalTaskCompleted);
        console.log(`totalCompletedTaskDB.rows[0].count`, totalCompletedTaskDB.rows[0].count)

        expect(duplicateTaskIds.length).toBe(0);
        expect(processedIds.size).toBe(MAX_TASKS);
        expect(totalTaskCompleted).toBe(MAX_TASKS);
        expect(Number(totalCompletedTaskDB.rows[0].count)).toBe(MAX_TASKS);
    }, 120000)
})