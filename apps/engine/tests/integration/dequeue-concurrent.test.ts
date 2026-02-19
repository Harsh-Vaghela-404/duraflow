import { Pool } from "pg";
import { TaskRepository } from "../../src/repositories/task.repository";
import {
  createTestPool,
  closePool,
  clearTables,
  createTask,
} from "../helpers/db";

describe("Concurrent Dequeue", () => {
  let pool: Pool;
  let repo: TaskRepository;

  beforeAll(async () => {
    pool = createTestPool();
    repo = new TaskRepository(pool);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it("dequeues tasks correctly", async () => {
    await clearTables(pool);

    // Create 10 tasks
    for (let i = 0; i < 10; i++) {
      await createTask(pool, "test-wf", { i });
    }

    // Dequeue 5 tasks
    const result = await repo.dequeue(5, "worker1");
    expect(result.length).toBe(5);

    // Verify all have correct status
    for (const task of result) {
      expect(task.status).toBe("running");
      expect(task.worker_id).toBe("worker1");
    }
  });

  it("handles empty queue gracefully", async () => {
    await clearTables(pool);
    const result = await repo.dequeue(10, "worker1");
    expect(result).toHaveLength(0);
  });
});
