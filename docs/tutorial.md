# Tutorial: Your First Workflow

Let's build a complete workflow to understand Duraflow's features.

## What We'll Build

A simple "Order Processing" workflow that demonstrates:

- Step execution with output persistence
- Retry logic for transient failures
- Error handling

## Step 1: Define the Workflow

Create `workflows/order.ts`:

```typescript
import { workflow } from "@duraflow/sdk";

interface OrderInput {
  orderId: string;
  customerEmail: string;
  items: Array<{ name: string; price: number }>;
}

interface OrderOutput {
  orderId: string;
  confirmationNumber: string;
  total: number;
}

export const orderWorkflow = workflow<OrderInput, OrderOutput>(
  "order-processing",
  async (ctx) => {
    const { orderId, customerEmail, items } = ctx.input;

    // Step 1: Validate order
    const validated = await ctx.step.run("validate-order", async () => {
      if (!items || items.length === 0) {
        throw new Error("Order has no items");
      }
      if (!customerEmail.includes("@")) {
        throw new Error("Invalid email address");
      }
      return { valid: true, itemCount: items.length };
    });

    // Step 2: Calculate total
    const total = await ctx.step.run("calculate-total", async () => {
      return items.reduce((sum, item) => sum + item.price, 0);
    });

    // Step 3: Process payment (with retry for transient failures)
    const payment = await ctx.step.run(
      "process-payment",
      async () => {
        // Simulate API call that might fail transiently
        const success = await fakePaymentApi(orderId, total);
        if (!success) throw new Error("Payment failed");
        return { transactionId: "TXN-" + Date.now(), amount: total };
      },
      {
        retries: 3, // Retry up to 3 times on failure
      },
    );

    // Step 4: Create order
    const order = await ctx.step.run("create-order", async () => {
      return {
        orderId,
        confirmationNumber:
          "CONF-" + Math.random().toString(36).substr(2, 9).toUpperCase(),
        total: total,
      };
    });

    return order;
  },
);

// Mock function to simulate payment API
async function fakePaymentApi(
  orderId: string,
  amount: number,
): Promise<boolean> {
  // 30% chance of transient failure
  return Math.random() > 0.3;
}
```

## Step 2: Register Workflows

Create `workflows/index.ts`:

```typescript
export { orderWorkflow } from "./order";
```

## Step 3: Start Engine with Workflows

```bash
DURAFLOW_WORKFLOWS=./workflows/index.ts npm run dev
```

## Step 4: Submit Task

Using the SDK or gRPC client:

```typescript
import { AgentServiceClient, credentials } from "@duraflow/proto";

const client = new AgentServiceClient(
  "localhost:50051",
  credentials.createInsecure(),
);

// Submit order
const response = await client.submitTask({
  workflowName: "order-processing",
  input: JSON.stringify({
    orderId: "ORD-123",
    customerEmail: "customer@example.com",
    items: [
      { name: "Widget", price: 29.99 },
      { name: "Gadget", price: 49.99 },
    ],
  }),
});

console.log("Task ID:", response.taskId);

// Poll for status
const status = await client.getTaskStatus({ taskId: response.taskId });
console.log("Status:", status.status);
console.log("Output:", status.output);
```

## What Happens Behind the Scenes

```
1. Task submitted → stored in agent_tasks (status: PENDING)

2. Poller picks up task → status: RUNNING

3. Step: validate-order
   - Creates step_runs record
   - Executes function
   - Saves output to step_runs.output
   - Status: COMPLETED

4. Step: calculate-total
   - Same process as above
   - Status: COMPLETED

5. Step: process-payment
   - First attempt: might fail
   - Retry with exponential backoff: 1s → 4s → 16s
   - Eventually succeeds (or fails after 3 retries)
   - Status: COMPLETED (or FAILED)

6. Step: create-order
   - Status: COMPLETED

7. Task completed → status: COMPLETED, output stored
```

## Crash Recovery Demo

### Simulate a Crash

1. Start workflow
2. Let it run for 2-3 steps
3. Kill the engine (`Ctrl+C`)
4. Restart the engine

**What happens:**

- Duraflow finds the task in RUNNING state
- Checks step_runs for completed steps
- Resumes from first incomplete step
- Completed steps are NOT re-executed (memoization)

## Error Handling

### If Payment Fails Permanently

```typescript
// After 3 retries, the step is marked as FAILED
// Workflow fails, task status becomes FAILED

const status = await client.getTaskStatus({ taskId: response.taskId });
// status.status === "failed"
// status.error contains the error details
```

### Cancel a Running Task

```typescript
await client.cancelTask({ taskId: response.taskId });
// Task status becomes CANCELLED
// If running, steps don't execute compensation (by default)
```

## Complete Code

```typescript
// Full example with error handling
import { workflow, taskStatus } from "@duraflow/sdk";
import { AgentServiceClient, credentials } from "@duraflow/proto";

const orderWorkflow = workflow("order-processing", async (ctx) => {
  // ... workflow implementation ...
});

async function submitAndMonitor() {
  const client = new AgentServiceClient(
    "localhost:50051",
    credentials.createInsecure(),
  );

  // Submit
  const { taskId } = await client.submitTask({
    workflowName: "order-processing",
    input: JSON.stringify({
      orderId: "ORD-123",
      customerEmail: "test@example.com",
      items: [{ name: "Item", price: 10 }],
    }),
  });

  // Poll for completion
  while (true) {
    const status = await client.getTaskStatus({ taskId });

    if (status.status === taskStatus.COMPLETED) {
      console.log("Success!", status.output);
      break;
    } else if (status.status === taskStatus.FAILED) {
      console.log("Failed:", status.error);
      break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

## Next Steps

- [Core Concepts](./concepts) - Deep dive into how Duraflow works
- [Saga Pattern](./sagas) - Learn about compensation and rollback
- [API Reference](./api/overview) - Full API documentation
