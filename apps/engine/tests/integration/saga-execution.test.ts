import { Pool } from "pg";
import path from "path";
import { createPiscinaPool, WorkflowExecutor } from "../../src/services/workflow-executor";
import { createTestPool, closePool, clearTables, createTask, getTask } from "../helpers/db";
import { StepRepository } from "../../src/repositories/step.repository";
import { taskStatus } from "../../src/db/task.entity";
import { stepStatus } from "../../src/db/step_runs.entity";
// Importing the workflow module registers "booking-saga" and its compensations
// in THIS (main) process — which is where the rollback runs.
import {
  cancellationOrder,
  resetCancellationOrder,
  resetMockBookings,
} from "../workflows/booking-saga";

// This is the test that would have caught B1: it drives a saga through the real
// worker path (Piscina worker executes the steps, then the main-thread
// RollbackOrchestrator compensates). The old suite only tested the orchestrator
// in isolation with hand-set data, so it never exercised this seam.
describe("Saga execution through the worker path (integration)", () => {
  let pool: Pool;
  // any: Piscina instance shape isn't needed here
  let piscina: any;
  let executor: WorkflowExecutor;
  let stepRepo: StepRepository;

  beforeAll(() => {
    pool = createTestPool();
    // The worker thread loads workflows from here.
    process.env.DURAFLOW_WORKFLOWS = path.resolve(__dirname, "../workflows/booking-saga.ts");
    piscina = createPiscinaPool();
    executor = new WorkflowExecutor(pool, piscina);
    stepRepo = new StepRepository(pool);
  });

  afterAll(async () => {
    await executor.destroy();
    await closePool(pool);
  });

  beforeEach(async () => {
    await clearTables(pool);
    resetCancellationOrder();
    resetMockBookings();
  });

  it("persists compensation_fn and runs compensations LIFO when a saga step fails", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-e2e",
      flightDetails: { from: "BLR", to: "DEL", date: "2026-07-10" },
      hotelDetails: { city: "DEL", checkIn: "2026-07-10", checkOut: "2026-07-12" },
      carDetails: { city: "DEL", pickUp: "2026-07-10", dropOff: "2026-07-12" },
      paymentAmount: 1000,
    });

    // charge-payment throws -> execute() fails the task, runs rollback (awaited),
    // then re-throws the original error.
    await expect(executor.execute(task)).rejects.toThrow(/PAYMENT_DECLINED/);

    // All compensations succeeded -> task ends rolled_back.
    const finalTask = await getTask(pool, task.id);
    expect(finalTask.status).toBe(taskStatus.ROLLED_BACK);

    // Each completed step must have compensation_fn PERSISTED (proves B1a) and be
    // marked rolled_back (proves B1b — the name resolved to a real function in the
    // main thread and the compensation actually ran).
    for (const key of ["book-flight", "book-hotel", "book-car"]) {
      const step = await stepRepo.findByTaskAndKey(task.id, key);
      expect(step).not.toBeNull();
      expect(step!.compensation_fn).toBe(`booking-saga:${key}`);
      expect(step!.status).toBe(stepStatus.ROLLED_BACK);
    }

    // The failing step has no compensation and never completed.
    const payment = await stepRepo.findByTaskAndKey(task.id, "charge-payment");
    expect(payment!.status).toBe(stepStatus.FAILED);
    expect(payment!.compensation_fn).toBeNull();

    // Compensations ran in LIFO order (last completed is undone first).
    expect(cancellationOrder).toEqual(["car", "hotel", "flight"]);
  });
});
