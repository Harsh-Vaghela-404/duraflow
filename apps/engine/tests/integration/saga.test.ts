import { Pool } from "pg";
import Redis from "ioredis";
import { RollbackOrchestrator } from "../../src/services/rollback-orchestrator";
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
  bookingWorkflow,
  resetCancellationOrder,
  resetMockBookings,
  getCancellationOrder,
  mockBookings,
  cancellationOrder,
} from "../../src/workflows/booking-saga";
import { registerCompensation } from "@duraflow/sdk";

describe("Saga Booking Test", () => {
  let pool: Pool;
  let redis: Redis;
  let stepRepo: StepRepository;
  let taskRepo: TaskRepository;
  let rollbackOrchestrator: RollbackOrchestrator;

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
    stepRepo = new StepRepository(pool);
    taskRepo = new TaskRepository(pool);
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

    const cancelFlight = async (output: any) => {
      for (const [key, booking] of mockBookings.flights) {
        if (!booking.cancelled) {
          booking.cancelled = true;
          break;
        }
      }
    };

    const cancelHotel = async (output: any) => {
      for (const [key, booking] of mockBookings.hotels) {
        if (!booking.cancelled) {
          booking.cancelled = true;
          break;
        }
      }
    };

    const cancelCar = async (output: any) => {
      for (const [key, booking] of mockBookings.cars) {
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

  it("should execute booking saga and rollback in LIFO order when payment fails", async () => {
    const input = {
      customerId: "cust-123",
      flightDetails: { from: "NYC", to: "LA", date: "2026-03-15" },
      hotelDetails: {
        city: "LA",
        checkIn: "2026-03-15",
        checkOut: "2026-03-20",
      },
      carDetails: { city: "LA", pickUp: "2026-03-15", dropOff: "2026-03-20" },
      paymentAmount: 5000,
    };

    const task = await createTask(pool, "booking-saga", input);

    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(
      task.id,
      "book-flight",
      input.flightDetails,
    );
    await stepRepo.updateCompleted(
      flightStep.id,
      { bookingId: "FLIGHT-123", ...input.flightDetails },
      "booking-saga:book-flight",
    );

    const hotelStep = await stepRepo.createOrFind(
      task.id,
      "book-hotel",
      input.hotelDetails,
    );
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HOTEL-456", ...input.hotelDetails },
      "booking-saga:book-hotel",
    );

    const carStep = await stepRepo.createOrFind(
      task.id,
      "book-car",
      input.carDetails,
    );
    await stepRepo.updateCompleted(
      carStep.id,
      { bookingId: "CAR-789", ...input.carDetails },
      "booking-saga:book-car",
    );

    mockBookings.flights.set("cust-123", {
      bookingId: "FLIGHT-123",
      cancelled: false,
    });
    mockBookings.hotels.set("cust-123", {
      bookingId: "HOTEL-456",
      cancelled: false,
    });
    mockBookings.cars.set("cust-123", {
      bookingId: "CAR-789",
      cancelled: false,
    });

    const taskEntity = await taskRepo.findById(task.id);
    expect(taskEntity?.status).toBe(taskStatus.RUNNING);

    const result = await rollbackOrchestrator.rollback(task.id);

    expect(result.totalSteps).toBe(3);
    expect(result.compensated).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.finalStatus).toBe(taskStatus.ROLLED_BACK);

    const finalTask = await taskRepo.findById(task.id);
    expect(finalTask?.status).toBe(taskStatus.ROLLED_BACK);

    const flightCancelled = Array.from(mockBookings.flights.values()).some(
      (b) => b.cancelled,
    );
    const hotelCancelled = Array.from(mockBookings.hotels.values()).some(
      (b) => b.cancelled,
    );
    const carCancelled = Array.from(mockBookings.cars.values()).some(
      (b) => b.cancelled,
    );
    expect(flightCancelled).toBe(true);
    expect(hotelCancelled).toBe(true);
    expect(carCancelled).toBe(true);

    const updatedFlightStep = await stepRepo.findByTaskAndKey(
      task.id,
      "book-flight",
    );
    const updatedHotelStep = await stepRepo.findByTaskAndKey(
      task.id,
      "book-hotel",
    );
    const updatedCarStep = await stepRepo.findByTaskAndKey(task.id, "book-car");

    expect(updatedFlightStep?.compensated_at).toBeInstanceOf(Date);
    expect(updatedHotelStep?.compensated_at).toBeInstanceOf(Date);
    expect(updatedCarStep?.compensated_at).toBeInstanceOf(Date);
  });

  it("should handle partial rollback when compensation fails", async () => {
    const input = {
      customerId: "cust-456",
      flightDetails: { from: "SFO", to: "SEA", date: "2026-04-01" },
      hotelDetails: {
        city: "SEA",
        checkIn: "2026-04-01",
        checkOut: "2026-04-05",
      },
      carDetails: { city: "SEA", pickUp: "2026-04-01", dropOff: "2026-04-05" },
      paymentAmount: 3000,
    };

    const task = await createTask(pool, "booking-saga", input);
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(
      task.id,
      "book-flight",
      input.flightDetails,
    );
    await stepRepo.updateCompleted(
      flightStep.id,
      { bookingId: "FLIGHT-999", ...input.flightDetails },
      "booking-saga:book-flight",
    );

    const hotelStep = await stepRepo.createOrFind(
      task.id,
      "book-hotel",
      input.hotelDetails,
    );
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HOTEL-888", ...input.hotelDetails },
      "non-existent-compensation",
    );

    const carStep = await stepRepo.createOrFind(
      task.id,
      "book-car",
      input.carDetails,
    );
    await stepRepo.updateCompleted(
      carStep.id,
      { bookingId: "CAR-777", ...input.carDetails },
      "booking-saga:book-car",
    );

    const paymentStep = await stepRepo.createOrFind(task.id, "charge-payment", {
      amount: input.paymentAmount,
    });
    await stepRepo.updateFailed(paymentStep.id, {
      message: "PAYMENT_DECLINED",
    });

    const result = await rollbackOrchestrator.rollback(task.id);

    expect(result.compensated).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.finalStatus).toBe(taskStatus.PARTIAL_ROLLBACK);

    const finalTask = await taskRepo.findById(task.id);
    expect(finalTask?.status).toBe(taskStatus.PARTIAL_ROLLBACK);

    const dlqItems = await pool.query(
      "SELECT * FROM dead_letter_queue WHERE task_id = $1",
      [task.id],
    );
    expect(dlqItems.rows.length).toBe(1);
    expect(dlqItems.rows[0].step_id).toBe(hotelStep.id);
  });

  it("should skip steps without compensation during rollback", async () => {
    const input = {
      customerId: "cust-789",
      flightDetails: { from: "BOS", to: "MIA", date: "2026-05-01" },
      hotelDetails: {
        city: "MIA",
        checkIn: "2026-05-01",
        checkOut: "2026-05-05",
      },
      carDetails: { city: "MIA", pickUp: "2026-05-01", dropOff: "2026-05-05" },
      paymentAmount: 4000,
    };

    const task = await createTask(pool, "booking-saga", input);
    await taskRepo.updateStatus(task.id, taskStatus.RUNNING);

    const flightStep = await stepRepo.createOrFind(
      task.id,
      "book-flight",
      input.flightDetails,
    );
    await stepRepo.updateCompleted(flightStep.id, {
      bookingId: "FLIGHT-111",
      ...input.flightDetails,
    });

    const hotelStep = await stepRepo.createOrFind(
      task.id,
      "book-hotel",
      input.hotelDetails,
    );
    await stepRepo.updateCompleted(
      hotelStep.id,
      { bookingId: "HOTEL-222", ...input.hotelDetails },
      "booking-saga:book-hotel",
    );

    const paymentStep = await stepRepo.createOrFind(task.id, "charge-payment", {
      amount: input.paymentAmount,
    });
    await stepRepo.updateFailed(paymentStep.id, {
      message: "PAYMENT_DECLINED",
    });

    mockBookings.hotels.set("cust-789", {
      bookingId: "HOTEL-222",
      cancelled: false,
    });

    resetCancellationOrder();

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

  it("should handle empty workflow (no steps to rollback)", async () => {
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
});
