import { Pool } from "pg";
import Redis from "ioredis";
import { RollbackOrchestrator } from "../../src/services/rollback-orchestrator";
import { DeadLetterQueueRepository } from "../../src/repositories/dlq.repository";
import {
  createTestPool,
  createTestRedis,
  closePool,
  clearTables,
  createTask,
} from "../helpers/db";
import { taskStatus } from "../../src/db/task.entity";
import { StepRepository } from "../../src/repositories/step.repository";
import { TaskRepository } from "../../src/repositories/task.repository";
import {
  resetCancellationOrder,
  resetMockBookings,
  mockBookings,
} from "../../src/workflows/booking-saga";
import { registerCompensation } from "@duraflow/sdk";

describe("Saga Edge Cases", () => {
  let pool: Pool;
  let redis: Redis;
  let stepRepo: StepRepository;
  let taskRepo: TaskRepository;
  let dlqRepo: DeadLetterQueueRepository;
  let rollbackOrchestrator: RollbackOrchestrator;

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
    stepRepo = new StepRepository(pool);
    taskRepo = new TaskRepository(pool);
    dlqRepo = new DeadLetterQueueRepository(pool);
    rollbackOrchestrator = new RollbackOrchestrator(pool);
  });

  afterAll(async () => {
    await closePool(pool);
    await redis.quit();
  });

  beforeEach(async () => {
    await clearTables(pool);
    await redis.flushall();
    resetCancellationOrder();
    resetMockBookings();

    const cancelFlight = async () => {
      for (const [, booking] of mockBookings.flights) {
        if (!booking.cancelled) {
          booking.cancelled = true;
          break;
        }
      }
    };

    const cancelHotel = async () => {
      for (const [, booking] of mockBookings.hotels) {
        if (!booking.cancelled) {
          booking.cancelled = true;
          break;
        }
      }
    };

    const cancelCar = async () => {
      for (const [, booking] of mockBookings.cars) {
        if (!booking.cancelled) {
          booking.cancelled = true;
          break;
        }
      }
    };

    registerCompensation("booking-saga:book-flight", cancelFlight);
    registerCompensation("booking-saga:book-hotel", cancelHotel);
    registerCompensation("booking-saga:book-car", cancelCar);
  });

  it("should handle compensation function throws error → goes to DLQ", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-throw",
    });
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(task.id, "book-flight", {
      from: "ATL",
      to: "DEN",
    });
    await stepRepo.updateCompleted(
      flightStep.id,
      { bookingId: "FL-THROW" },
      "booking-saga:book-flight",
    );

    const hotelStep = await stepRepo.createOrFind(task.id, "book-hotel", {
      city: "DEN",
    });
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HT-THROW" },
      "compensation-that-throws",
    );

    registerCompensation("compensation-that-throws", async () => {
      throw new Error("Intentional compensation failure");
    });

    const result = await rollbackOrchestrator.rollback(task.id);

    expect(result.totalSteps).toBe(2);
    expect(result.compensated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.finalStatus).toBe(taskStatus.PARTIAL_ROLLBACK);

    const dlqItems = await dlqRepo.findByTaskId(task.id);
    expect(dlqItems.length).toBe(1);
    expect(dlqItems[0]!.step_id).toBe(hotelStep.id);
    expect(dlqItems[0]!.retry_count).toBe(0);
  });

  it("should handle compensation times out → treated as failure", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-timeout",
    });
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(task.id, "book-flight", {
      from: "ORD",
      to: "PHX",
    });
    await stepRepo.updateCompleted(
      flightStep.id,
      { bookingId: "FL-TIMEOUT" },
      "compensation-timeout",
    );

    const longRunningCompensation = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    };
    registerCompensation("compensation-timeout", longRunningCompensation);

    const result = await rollbackOrchestrator.rollback(task.id, {
      compensationTimeoutMs: 100,
    });

    expect(result.failed).toBe(1);
    expect(result.finalStatus).toBe(taskStatus.PARTIAL_ROLLBACK);

    const dlqItems = await dlqRepo.findByTaskId(task.id);
    expect(dlqItems.length).toBe(1);
    expect(dlqItems[0]!.step_id).toBe(flightStep.id);
  });

  it("should handle task cancelled mid-flight → rollback triggers", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-cancel",
    });
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(task.id, "book-flight", {
      from: "LAX",
      to: "JFK",
    });
    await stepRepo.updateCompleted(
      flightStep.id,
      { bookingId: "FL-CANCEL" },
      "booking-saga:book-flight",
    );

    const hotelStep = await stepRepo.createOrFind(task.id, "book-hotel", {
      city: "JFK",
    });
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HT-CANCEL" },
      "booking-saga:book-hotel",
    );

    mockBookings.flights.set("cust-cancel", {
      bookingId: "FL-CANCEL",
      cancelled: false,
    });
    mockBookings.hotels.set("cust-cancel", {
      bookingId: "HT-CANCEL",
      cancelled: false,
    });

    await taskRepo.updateStatus(task.id, taskStatus.CANCELLED);

    const result = await rollbackOrchestrator.rollback(task.id);

    expect(result.totalSteps).toBe(2);
    expect(result.compensated).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.finalStatus).toBe(taskStatus.ROLLED_BACK);

    const flightCancelled = Array.from(mockBookings.flights.values()).some(
      (b) => b.cancelled,
    );
    const hotelCancelled = Array.from(mockBookings.hotels.values()).some(
      (b) => b.cancelled,
    );
    expect(flightCancelled).toBe(true);
    expect(hotelCancelled).toBe(true);
  });

  it("should skip step without compensation → skipped in rollback", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-skip",
    });
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(task.id, "book-flight", {
      from: "BOS",
      to: "MIA",
    });
    await stepRepo.updateCompleted(flightStep.id, { bookingId: "FL-SKIP" });

    const hotelStep = await stepRepo.createOrFind(task.id, "book-hotel", {
      city: "MIA",
    });
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HT-SKIP" },
      "booking-saga:book-hotel",
    );

    mockBookings.hotels.set("cust-skip", {
      bookingId: "HT-SKIP",
      cancelled: false,
    });

    const result = await rollbackOrchestrator.rollback(task.id);

    expect(result.totalSteps).toBe(1);
    expect(result.compensated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.finalStatus).toBe(taskStatus.ROLLED_BACK);

    const hotelCancelled = Array.from(mockBookings.hotels.values()).some(
      (b) => b.cancelled,
    );
    expect(hotelCancelled).toBe(true);
  });

  it("should handle empty workflow fails → no compensations needed", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-empty",
    });
    await taskRepo.updateStatus(task.id, taskStatus.FAILED);

    const result = await rollbackOrchestrator.rollback(task.id);

    expect(result.totalSteps).toBe(0);
    expect(result.compensated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.finalStatus).toBe(taskStatus.ROLLED_BACK);

    const finalTask = await taskRepo.findById(task.id);
    expect(finalTask?.status).toBe(taskStatus.ROLLED_BACK);
  });

  it("should handle all compensations fail → all go to DLQ", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-all-fail",
    });
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(task.id, "book-flight", {
      from: "SEA",
      to: "PDX",
    });
    await stepRepo.updateCompleted(
      flightStep.id,
      { bookingId: "FL-FAIL" },
      "comp-fail-1",
    );

    const hotelStep = await stepRepo.createOrFind(task.id, "book-hotel", {
      city: "PDX",
    });
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HT-FAIL" },
      "comp-fail-2",
    );

    const carStep = await stepRepo.createOrFind(task.id, "book-car", {
      city: "PDX",
    });
    await stepRepo.updateCompleted(
      carStep.id,
      { bookingId: "CR-FAIL" },
      "comp-fail-3",
    );

    registerCompensation("comp-fail-1", async () => {
      throw new Error("Flight cancel failed");
    });
    registerCompensation("comp-fail-2", async () => {
      throw new Error("Hotel cancel failed");
    });
    registerCompensation("comp-fail-3", async () => {
      throw new Error("Car cancel failed");
    });

    const result = await rollbackOrchestrator.rollback(task.id);

    expect(result.totalSteps).toBe(3);
    expect(result.compensated).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.finalStatus).toBe(taskStatus.PARTIAL_ROLLBACK);

    const dlqItems = await dlqRepo.findByTaskId(task.id);
    expect(dlqItems.length).toBe(3);

    const stepIds = dlqItems.map((item) => item.step_id);
    expect(stepIds).toContain(carStep.id);
    expect(stepIds).toContain(hotelStep.id);
    expect(stepIds).toContain(flightStep.id);
  });

  it("should handle partial rollback status set correctly", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-partial",
    });
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(task.id, "book-flight", {
      from: "DFW",
      to: "IAH",
    });
    await stepRepo.updateCompleted(
      flightStep.id,
      { bookingId: "FL-PARTIAL" },
      "booking-saga:book-flight",
    );

    const hotelStep = await stepRepo.createOrFind(task.id, "book-hotel", {
      city: "IAH",
    });
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HT-PARTIAL" },
      "comp-partial-fail",
    );

    const carStep = await stepRepo.createOrFind(task.id, "book-car", {
      city: "IAH",
    });
    await stepRepo.updateCompleted(
      carStep.id,
      { bookingId: "CR-PARTIAL" },
      "booking-saga:book-car",
    );

    mockBookings.flights.set("cust-partial", {
      bookingId: "FL-PARTIAL",
      cancelled: false,
    });
    mockBookings.cars.set("cust-partial", {
      bookingId: "CR-PARTIAL",
      cancelled: false,
    });

    registerCompensation("comp-partial-fail", async () => {
      throw new Error("Hotel compensation unavailable");
    });

    const result = await rollbackOrchestrator.rollback(task.id);

    expect(result.totalSteps).toBe(3);
    expect(result.compensated).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.finalStatus).toBe(taskStatus.PARTIAL_ROLLBACK);

    const finalTask = await taskRepo.findById(task.id);
    expect(finalTask?.status).toBe(taskStatus.PARTIAL_ROLLBACK);

    const flightCancelled = Array.from(mockBookings.flights.values()).some(
      (b) => b.cancelled,
    );
    const carCancelled = Array.from(mockBookings.cars.values()).some(
      (b) => b.cancelled,
    );
    expect(flightCancelled).toBe(true);
    expect(carCancelled).toBe(true);
  });

  it("should handle DLQ retry successfully", async () => {
    const task = await createTask(pool, "booking-saga", {
      customerId: "cust-retry",
    });
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const hotelStep = await stepRepo.createOrFind(task.id, "book-hotel", {
      city: "DTW",
    });
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HT-RETRY" },
      "comp-retryable",
    );

    let attemptCount = 0;
    registerCompensation("comp-retryable", async () => {
      attemptCount++;
      if (attemptCount < 2) {
        throw new Error("Transient failure, try again");
      }
    });

    const result = await rollbackOrchestrator.rollback(task.id);
    expect(result.failed).toBe(1);

    const dlqItems = await dlqRepo.findByTaskId(task.id);
    expect(dlqItems.length).toBe(1);
    expect(dlqItems[0]!.retry_count).toBe(0);

    const dlqId = dlqItems[0]!.id;
    const retryResult = await dlqRepo.retry(dlqId);
    expect(retryResult.success).toBe(true);

    const dlqItemsAfterRetry = await pool.query(
      "SELECT * FROM dead_letter_queue WHERE id = $1",
      [dlqId],
    );
    expect(dlqItemsAfterRetry.rows.length).toBe(0);
  });
});
