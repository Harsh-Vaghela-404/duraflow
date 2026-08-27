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

Compensations are declared in a `compensations` map on the workflow, keyed by step key. Each one is a **pure function of that step's saved output** - see [Compensation Function](#compensation-function) for why.

```typescript
import { workflow } from '@duraflow/sdk';

const bookingWorkflow = workflow(
    'booking',
    async (ctx) => {
        const flight = await ctx.step.run('book-flight', async () => {
            return await api.bookFlight(ctx.input.flightDetails);
        });

        const hotel = await ctx.step.run('book-hotel', async () => {
            return await api.bookHotel(ctx.input.hotelDetails);
        });

        // If this step fails, both flight and hotel are automatically cancelled.
        const payment = await ctx.step.run('charge-payment', async () => {
            const result = await api.charge(ctx.input.payment);
            if (!result.success) throw new Error('Payment failed');
            return result;
        });

        return { flight, hotel, payment };
    },
    {
        // Keyed by step key. Run in LIFO order over completed steps on failure.
        compensations: {
            'book-flight': async (output) => {
                await api.cancelFlight(output.flightId);
            },
            'book-hotel': async (output) => {
                await api.cancelHotel(output.hotelId);
            },
            // charge-payment has no compensation - nothing to undo.
        },
    },
);
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

A compensation receives the step's **saved output** (read back from the database) and undoes its effects. It **must be a pure function of that output** - it may not close over variables from the workflow handler.

Why: a rollback can run in a different process (or after a crash) than the one that executed the step. Only what the step _returned and persisted_ is guaranteed to be available. Compensations are registered by step key at module load, so the engine can resolve and run them anywhere.

```typescript
// Declared in the workflow's `compensations` map, keyed by step key:
compensations: {
  "book-flight": async (output: BookingOutput) => {
    // `output` is exactly what the step returned.
    await api.cancelFlight(output.bookingId);
  },
}
```

## Full Example: Travel Booking

```typescript
import { workflow } from '@duraflow/sdk';

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
        method: 'DELETE',
    });
}

async function cancelHotel(output: any) {
    console.log(`[saga] Cancelling hotel ${output.hotelId}`);
    await fetch(`https://hotel-api.com/reservations/${output.hotelId}`, {
        method: 'DELETE',
    });
}

async function cancelCar(output: any) {
    console.log(`[saga] Cancelling car ${output.carId}`);
    await fetch(`https://car-api.com/rentals/${output.carId}`, {
        method: 'DELETE',
    });
}

// Workflow definition - compensations are attached in the options below.
export const bookingSaga = workflow<BookingInput, BookingOutput>(
    'booking',
    async (ctx) => {
        const { destination, dates, travelers, paymentMethod } = ctx.input;

        // Step 1: Book flight
        const flight = await ctx.step.run('book-flight', async () => {
            const res = await fetch('https://airline-api.com/book', {
                method: 'POST',
                body: JSON.stringify({ destination, dates, travelers }),
            });
            return { flightId: res.id, price: res.price };
        });

        // Step 2: Book hotel
        const hotel = await ctx.step.run('book-hotel', async () => {
            const res = await fetch('https://hotel-api.com/reserve', {
                method: 'POST',
                body: JSON.stringify({ destination, dates }),
            });
            return { hotelId: res.id, price: res.price };
        });

        // Step 3: Book car
        const car = await ctx.step.run('book-car', async () => {
            const res = await fetch('https://car-api.com/rent', {
                method: 'POST',
                body: JSON.stringify({ destination, dates }),
            });
            return { carId: res.id, price: res.price };
        });

        // Step 4: Process payment (failure point)
        const total = flight.price + hotel.price + car.price;
        const payment = await ctx.step.run('charge-payment', async () => {
            const res = await fetch('https://payment-api.com/charge', {
                method: 'POST',
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
    {
        compensations: {
            'book-flight': cancelFlight,
            'book-hotel': cancelHotel,
            'book-car': cancelCar,
        },
    },
);
```

## Best Practices

### 1. Make Compensations Idempotent

Compensations can be called multiple times (e.g., manual retry from DLQ). Design them to succeed regardless of how many times they run:

```typescript
// Safe to call more than once - a 404 means it's already cancelled.
async function cancelFlight(output) {
    const res = await fetch(`/flights/${output.id}`, { method: 'DELETE' });
    if (res.status === 404 || res.status === 200) return;
    if (!res.ok) throw new Error('Cancel failed');
}

// Not safe - the second call throws because the row is already gone.
async function cancelFlight(output) {
    await db.delete('flights', { id: output.id });
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
            method: 'DELETE',
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
// The step returns everything its compensation will need:
await ctx.step.run("create-vm", async () => {
  const vm = await cloud.createInstance({ size: "large" });
  return {
    instanceId: vm.id,
    ip: vm.ip,
    region: vm.region,
    securityGroup: vm.securityGroup,
    createdAt: new Date().toISOString(),
  };
});

// ...and the compensation (in the workflow's `compensations` map) reads it back:
compensations: {
  "create-vm": async (output) => {
    await cloud.terminate(output.instanceId);
    await cloud.deleteSecurityGroup(output.securityGroup);
  },
}
```

### 4. Log Compensation Actions

Compensations run during failures when debugging is hardest:

```typescript
// entry in the workflow's `compensations` map:
"book-flight": async (output) => {
  console.log(`[saga] Cancelling flight ${output.flightId}`);
  const res = await api.cancelFlight(output.flightId);
  console.log(`[saga] Flight cancelled: ${res.ok}`);
},
```

### 5. Not Every Step Needs Compensation

Purely computational steps don't need compensations:

```typescript
// No entry in the compensations map - just parsing data:
const data = await ctx.step.run("parse-csv", async () => {
  return parseCSV(rawInput);
});

// Creates an external resource, so it gets a compensation:
const created = await ctx.step.run("create-user", async () => {
  return await api.createUser(data);
});

// In the workflow's `compensations` map:
compensations: {
  "create-user": async (output) => {
    await api.deleteUser(output.id);
  },
  // (no "parse-csv" key - nothing to undo)
}
```

## Dead Letter Queue (DLQ)

When a compensation fails:

1. Error is recorded in the DLQ
2. Task status becomes `PARTIAL_ROLLBACK`
3. Duraflow continues with remaining compensations
4. Manual intervention required to retry

### Check DLQ

```typescript
import { DeadLetterQueueRepository } from '@duraflow/engine';

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
    console.log('Compensation succeeded');
} else {
    console.log('Still failing:', result.error);
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

For the task-lifecycle side of this (SKIP LOCKED, the reaper), see [Core Concepts](./concepts).
