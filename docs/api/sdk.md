# SDK Reference

The Duraflow SDK provides a type-safe way to define workflows and interact with the engine.

## Installation

```bash
npm install @duraflow/sdk @duraflow/proto
```

## Core Functions

### `workflow<TInput, TOutput>(name, handler)`

Defines a new workflow with a unique name.

```typescript
import { workflow } from "@duraflow/sdk";

interface MyInput {
  userId: string;
}

interface MyOutput {
  result: string;
}

const myWorkflow = workflow<MyInput, MyOutput>("my-workflow", async (ctx) => {
  // ctx.input is typed as MyInput
  const { userId } = ctx.input;

  const result = await ctx.step.run("process", async () => {
    return `Processed user ${userId}`;
  });

  return { result };
});
```

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique workflow name (alphanumeric, dashes, underscores, max 100 chars) |
| `handler` | `(ctx: WorkflowContext) => Promise<TOutput>` | Async function that executes the workflow |

**Returns:** `Workflow<TOutput>`

### `ctx.step.run<T>(name, fn, options)`

Executes a step within a workflow.

```typescript
const result = await ctx.step.run<string>(
  "my-step",
  async () => {
    return "step output";
  },
  {
    retries: 3,
    timeout: 30000,
    compensation: async (output) => {
      // undo logic
    },
  },
);
```

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique step name within the workflow |
| `fn` | `() => Promise<T>` | Async function that executes the step |
| `options` | `StepOptions<T>?` | Optional configuration |

**Returns:** `Promise<T>` - The step's output

## Types

### WorkflowContext

```typescript
interface WorkflowContext<TInput = unknown> {
  // Unique identifier for this workflow run
  runId: string;

  // The workflow's name
  workflowName: string;

  // Input data passed to the workflow
  input: TInput;

  // Step runner for executing steps
  step: StepRunner;
}
```

### StepRunner

```typescript
interface StepRunner {
  run<T>(
    name: string,
    fn: () => Promise<T>,
    options?: StepOptions<T>,
  ): Promise<T>;
}
```

### StepOptions

```typescript
interface StepOptions<T = unknown> {
  // Number of retry attempts on failure (default: 0)
  retries?: number;

  // Timeout in milliseconds (default: no timeout)
  timeout?: number;

  // Compensation function for saga rollback
  compensation?: (output: T) => Promise<void>;
}
```

### WorkflowHandler

```typescript
type WorkflowHandler<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowContext<TInput>,
) => Promise<TOutput>;
```

## Workflow Registry

### `registerWorkflow(name, handler)`

Register a workflow programmatically (alternative to using `workflow()`).

```typescript
import { registerWorkflow } from "@duraflow/sdk";

registerWorkflow("my-workflow", async (ctx) => {
  return { result: "done" };
});
```

### `getWorkflow(name)`

Retrieve a registered workflow.

```typescript
import { getWorkflow } from "@duraflow/sdk";

const wf = getWorkflow("my-workflow");
if (wf) {
  console.log("Found:", wf.name);
}
```

### `listWorkflows()`

List all registered workflow names.

```typescript
import { listWorkflows } from "@duraflow/sdk";

const names = listWorkflows();
console.log("Registered:", names);
```

## Compensation

### `registerCompensation(name, fn)`

Manually register a compensation function (useful in worker threads).

```typescript
import { registerCompensation } from "@duraflow/sdk";

registerCompensation("workflow:step-name", async (output) => {
  await api.cancel(output.id);
});
```

### `compensationRegistry.get(name)`

Retrieve a registered compensation.

```typescript
import { compensationRegistry } from "@duraflow/sdk";

const compensation = compensationRegistry.get("workflow:step-name");
```

## Serialization

### `serialize(value)`

Serialize a value to JSON string (uses SuperJSON for type preservation).

```typescript
import { serialize, deserialize } from "@duraflow/sdk";

const json = serialize({ date: new Date(), map: new Map([["key", "value"]]) });
// SuperJSON preserves types that regular JSON.stringify loses

const data = deserialize<MyType>(json);
```

**Note:** Maximum payload size is 1MB. Throws `SerializationError` if exceeded.

### `deserialize<T>(json)`

Deserialize a JSON string back to a value.

```typescript
const value = deserialize<MyType>(jsonString);
```

### SerializationError

```typescript
import { SerializationError } from "@duraflow/sdk";

try {
  serialize(veryLargeObject);
} catch (e) {
  if (e instanceof SerializationError) {
    console.log("Payload too large:", e.message);
  }
}
```

## Task Status

```typescript
import { taskStatus } from "@duraflow/sdk";

// Enum values
taskStatus.PENDING; // Waiting in queue
taskStatus.RUNNING; // Currently executing
taskStatus.COMPLETED; // Finished successfully
taskStatus.FAILED; // Failed with error
taskStatus.CANCELLED; // Manually cancelled
taskStatus.ROLLED_BACK; // All compensations succeeded
taskStatus.PARTIAL_ROLLBACK; // Some compensations failed
```

## Error Handling

### StepRetryError

Thrown when a step needs to be retried (handled automatically by the SDK).

```typescript
import { StepRetryError } from "@duraflow/sdk";

// This is thrown internally during retry
// You don't typically need to handle it directly
```

## Complete Example

```typescript
import {
  workflow,
  step,
  taskStatus,
  registerCompensation,
  serialize,
  deserialize,
} from "@duraflow/sdk";

// Define input/output types
interface OrderInput {
  orderId: string;
  customerEmail: string;
}

interface OrderOutput {
  confirmationNumber: string;
}

// Define the workflow
const orderWorkflow = workflow<OrderInput, OrderOutput>(
  "process-order",
  async (ctx) => {
    // Step 1: Validate order
    await ctx.step.run("validate", async () => {
      if (!ctx.input.customerEmail.includes("@")) {
        throw new Error("Invalid email");
      }
      return { valid: true };
    });

    // Step 2: Process with retry
    const result = await ctx.step.run(
      "process",
      async () => {
        // Simulate processing
        return {
          confirmationNumber: "CONF-" + Date.now(),
        };
      },
      {
        retries: 3,
        timeout: 30000,
      },
    );

    return result;
  },
);

// Export for use in engine
export { orderWorkflow };
```

## Workflow in Worker Threads

When using worker threads, register workflows via environment variable:

```bash
# In your workflow file
export const myWorkflow = workflow("my-workflow", async (ctx) => {
  // ...
});

// When starting engine
DURAFLOW_WORKFLOWS=./path/to/workflows.ts npm run dev
```

Or manually register in the worker entry:

```typescript
// workflow.worker.ts
import { registerWorkflow } from "@duraflow/sdk";
import { myWorkflow } from "./workflows";

// Auto-register all exported workflows
registerWorkflow(myWorkflow.name, myWorkflow.handler);
```
