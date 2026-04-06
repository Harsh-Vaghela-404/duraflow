# Sagas (Compensation & Rollback)

The **Saga pattern** enables automatic rollback of multi-step workflows when failures occur. If one step fails, all previously completed steps can be undone by executing their compensation functions.

## When to Use Sagas

Use the saga pattern when your workflow performs **multiple side effects** that must all succeed together:

| Use Case        | Example                                           |
| --------------- | ------------------------------------------------- |
| Booking systems | Flight + Hotel + Car + Payment                    |
| E-commerce      | Reserve inventory → Create order → Charge payment |
| Provisioning    | Create VM → Configure network → Attach storage    |
| Data pipelines  | Write to DB → Send notification → Update cache    |

## Quick Example

```typescript
import { workflow } from "@duraflow/sdk";

const bookingWorkflow = workflow("booking", async (ctx) => {
  // Step 1: Book flight with compensation
  const flight = await ctx.step.run(
    "book-flight",
    async () => {
      return await api.bookFlight(ctx.input.flightDetails);
    },
    {
      compensation: async (output) => {
        await api.cancelFlight(output.flightId);
      },
    },
  );

  // Step 2: Book hotel with compensation
  const hotel = await ctx.step.run(
    "book-hotel",
    async () => {
      return await api.bookHotel(ctx.input.hotelDetails);
    },
    {
      compensation: async (output) => {
        await api.cancelHotel(output.hotelId);
      },
    },
  );

  // If this step fails, both flight and hotel are automatically cancelled
  const payment = await ctx.step.run("charge-payment", async () => {
    const result = await api.charge(ctx.input.payment);
    if (!result.success) throw new Error("Payment failed");
    return result;
  });

  return { flight, hotel, payment };
});
```

## How Rollback Works

When a workflow fails:

```
Step 1: Book flight     → completed at 10:00:01
Step 2: Book hotel      → completed at 10:00:03
Step 3: Charge payment  → FAILED at 10:00:07
```

Duraflow executes compensations in **LIFO** (Last In First Out):

1. **Cancel hotel** (last completed step)
2. **Cancel flight** (first completed step)

This reverse order matters because later steps often depend on earlier ones.

## Compensation Function

A compensation function receives the step's output and undoes its effects:

```typescript
compensation: async (output: BookingOutput) => {
  // output contains whatever the step returned
  await api.cancelFlight(output.bookingId);
};
```

## Full Example: Travel Booking

```typescript
import { workflow } from "@duraflow/sdk";

interface BookingInput {
  destination: string;
  dates: { start: string; end: string };
  travelers: number;
  paymentMethod: string;
}

interface BookingOutput {
  confirmation: {
    flight: string;
    hotel: string;
    car: string;
  };
  total: number;
}

// Compensation functions
async function cancelFlight(output: any) {
  console.log(`[saga] Cancelling flight ${output.flightId}`);
  await fetch(`https://airline-api.com/bookings/${output.flightId}`, {
    method: "DELETE",
  });
}

async function cancelHotel(output: any) {
  console.log(`[saga] Cancelling hotel ${output.hotelId}`);
  await fetch(`https://hotel-api.com/reservations/${output.hotelId}`, {
    method: "DELETE",
  });
}

async function cancelCar(output: any) {
  console.log(`[saga] Cancelling car ${output.carId}`);
  await fetch(`https://car-api.com/rentals/${output.carId}`, {
    method: "DELETE",
  });
}

// Register compensations (for use in worker threads)
import { registerCompensation } from "@duraflow/sdk";
registerCompensation("booking:book-flight", cancelFlight);
registerCompensation("booking:book-hotel", cancelHotel);
registerCompensation("booking:book-car", cancelCar);

// Workflow definition
export const bookingSaga = workflow<BookingInput, BookingOutput>(
  "booking",
  async (ctx) => {
    const { destination, dates, travelers, paymentMethod } = ctx.input;

    // Step 1: Book flight
    const flight = await ctx.step.run(
      "book-flight",
      async () => {
        const res = await fetch("https://airline-api.com/book", {
          method: "POST",
          body: JSON.stringify({ destination, dates, travelers }),
        });
        return { flightId: res.id, price: res.price };
      },
      {
        compensation: cancelFlight,
      },
    );

    // Step 2: Book hotel
    const hotel = await ctx.step.run(
      "book-hotel",
      async () => {
        const res = await fetch("https://hotel-api.com/reserve", {
          method: "POST",
          body: JSON.stringify({ destination, dates }),
        });
        return { hotelId: res.id, price: res.price };
      },
      {
        compensation: cancelHotel,
      },
    );

    // Step 3: Book car
    const car = await ctx.step.run(
      "book-car",
      async () => {
        const res = await fetch("https://car-api.com/rent", {
          method: "POST",
          body: JSON.stringify({ destination, dates }),
        });
        return { carId: res.id, price: res.price };
      },
      {
        compensation: cancelCar,
      },
    );

    // Step 4: Process payment (failure point)
    const total = flight.price + hotel.price + car.price;
    const payment = await ctx.step.run("charge-payment", async () => {
      const res = await fetch("https://payment-api.com/charge", {
        method: "POST",
        body: JSON.stringify({
          amount: total,
          method: paymentMethod,
        }),
      });

      if (!res.success) {
        throw new Error(`Payment failed: ${res.error}`);
      }
      return { transactionId: res.transactionId };
    });

    return {
      confirmation: {
        flight: flight.flightId,
        hotel: hotel.hotelId,
        car: car.carId,
      },
      total,
    };
  },
);
```

## Best Practices

### 1. Make Compensations Idempotent

Compensations can be called multiple times (e.g., manual retry from DLQ). Design them to succeed regardless of how many times they run:

```typescript
// ✅ Good: Safe to call multiple times
async function cancelFlight(output) {
  const res = await fetch(`/flights/${output.id}`, { method: "DELETE" });
  // 404 = already cancelled, treat as success
  if (res.status === 404 || res.status === 200) return;
  if (!res.ok) throw new Error("Cancel failed");
}

// ❌ Bad: Throws on second call
async function cancelFlight(output) {
  await db.delete("flights", { id: output.id });
  // Second call fails - row already deleted
}
```

### 2. Add Timeouts

External APIs can be slow during failures. Add explicit timeouts:

```typescript
async function cancelHotel(output) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    await fetch(`/hotels/${output.id}`, {
      method: "DELETE",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
```

### 3. Store All Required Data

Return everything the compensation will need:

```typescript
await ctx.step.run(
  "create-vm",
  async () => {
    const vm = await cloud.createInstance({ size: "large" });
    return {
      instanceId: vm.id,
      ip: vm.ip,
      region: vm.region,
      securityGroup: vm.securityGroup,
      createdAt: new Date().toISOString(),
    };
  },
  {
    compensation: async (output) => {
      await cloud.terminate(output.instanceId);
      await cloud.deleteSecurityGroup(output.securityGroup);
    },
  },
);
```

### 4. Log Compensation Actions

Compensations run during failures when debugging is hardest:

```typescript
compensation: async (output) => {
  console.log(`[saga] Cancelling flight ${output.flightId}`);
  const res = await api.cancelFlight(output.flightId);
  console.log(`[saga] Flight cancelled: ${res.ok}`);
};
```

### 5. Not Every Step Needs Compensation

Purely computational steps don't need compensations:

```typescript
// No compensation - just parsing data
const data = await ctx.step.run("parse-csv", async () => {
  return parseCSV(rawInput);
});

// Compensation needed - external API call
const created = await ctx.step.run(
  "create-user",
  async () => {
    return await api.createUser(data);
  },
  {
    compensation: async (output) => {
      await api.deleteUser(output.id);
    },
  },
);
```

## Dead Letter Queue (DLQ)

When a compensation fails:

1. Error is recorded in the DLQ
2. Task status becomes `PARTIAL_ROLLBACK`
3. Duraflow continues with remaining compensations
4. Manual intervention required to retry

### Check DLQ

```typescript
import { DeadLetterQueueRepository } from "@duraflow/engine";

// List failed compensations for a task
const dlqItems = await dlqRepo.findByTaskId(taskId);

// Check all DLQ items
const allItems = await dlqRepo.findAll(100, 0);
```

### Retry Failed Compensation

```typescript
// Retry a specific compensation
const result = await dlqRepo.retry(dlqItemId);

if (result.success) {
  console.log("Compensation succeeded");
} else {
  console.log("Still failing:", result.error);
}
```

## Task Status Reference

| Status             | Description                              |
| ------------------ | ---------------------------------------- |
| `COMPLETED`        | All steps succeeded, no rollback needed  |
| `FAILED`           | Step failed, no compensations registered |
| `ROLLED_BACK`      | All compensations succeeded              |
| `PARTIAL_ROLLBACK` | Some compensations failed (check DLQ)    |
| `CANCELLED`        | Manually cancelled before completion     |

## Rollback Timeout

By default, compensations timeout after 30 seconds. You can customize:

```typescript
// In engine configuration
const rollbackOrchestrator = new RollbackOrchestrator(pool, {
  compensationTimeoutMs: 60000, // 60 seconds
});

// Or per-rollback
await rollbackOrchestrator.rollback(taskId, {
  compensationTimeoutMs: 10000, // 10 seconds
});
```

If a compensation times out:

1. It's treated as a failure
2. Added to DLQ
3. Task becomes `PARTIAL_ROLLBACK`

---

## Related Topics

- [Core Concepts](./concepts) - Task lifecycle, SKIP LOCKED, Reaper
- [API Reference](./api/overview) - Full API docs
- [Tutorial](./tutorial) - Build your first workflow
