# API Overview

Duraflow provides multiple APIs to interact with the workflow engine.

## gRPC API (Primary)

The main API for high-performance communication. Use this for:

- Task submission
- Status polling
- Task cancellation
- Step operations (for SDK)

```typescript
import { AgentServiceClient, credentials } from "@duraflow/proto";

const client = new AgentServiceClient(
  "localhost:50051",
  credentials.createInsecure(),
);
```

## REST API (Coming Soon)

HTTP-based access for web applications and easier integration.

## SDK API

The TypeScript SDK provides the easiest way to define workflows.

```typescript
import { workflow, step } from "@duraflow/sdk";

const myWorkflow = workflow("my-workflow", async (ctx) => {
  const result = await ctx.step.run("my-step", async () => {
    return { data: "value" };
  });
  return result;
});
```

## Port Configuration

| Service              | Default Port | Environment Variable |
| -------------------- | ------------ | -------------------- |
| gRPC Server          | 50051        | `PORT`               |
| (REST - Coming Soon) | 3000         | `REST_PORT`          |

## Quick Examples

### Submit a Task (gRPC)

```typescript
const response = await client.submitTask({
  workflowName: "my-workflow",
  input: JSON.stringify({ key: "value" }),
});

console.log("Task ID:", response.taskId);
```

### Get Task Status (gRPC)

```typescript
const status = await client.getTaskStatus({
  taskId: "task-uuid-here",
});

console.log("Status:", status.status); // PENDING, RUNNING, COMPLETED, FAILED, etc.
console.log("Output:", status.output); // Task result (if completed)
console.log("Error:", status.error); // Error details (if failed)
```

### Cancel a Task (gRPC)

```typescript
const result = await client.cancelTask({
  taskId: "task-uuid-here",
});

console.log("Success:", result.success);
```

---

## Next Sections

- [SDK Reference](./sdk) - TypeScript SDK API
- [gRPC Reference](./grpc) - Full gRPC specification
- [Database Schema](/database) - Table structures
