# gRPC Reference

Complete reference for Duraflow's gRPC API.

## AgentService

The main service for workflow operations.

### SubmitTask

Submit a new workflow task for execution.

**Request:**

```protobuf
message SubmitTaskRequest {
  // Name of the workflow to execute (required)
  string workflow_name = 1;

  // Workflow input as JSON bytes (required)
  bytes input = 2;

  // Priority (higher = executes first, optional)
  int32 priority = 3;
}
```

**Response:**

```protobuf
message SubmitTaskResponse {
  // Unique task ID for tracking
  string task_id = 1;
}
```

**Example:**

```typescript
const response = await client.submitTask({
  workflowName: "order-processing",
  input: JSON.stringify({ orderId: "123" }),
});
console.log(response.taskId); // "abc-123-def-456"
```

---

### GetTaskStatus

Get the current status of a task.

**Request:**

```protobuf
message GetTaskStatusRequest {
  // Task ID from SubmitTaskResponse (required)
  string task_id = 1;
}
```

**Response:**

```protobuf
message GetTaskStatusResponse {
  // Current task status
  TaskStatus status = 1;

  // Task output (only if status = COMPLETED)
  bytes output = 2;

  // Error details (only if status = FAILED)
  bytes error = 3;
}
```

**Example:**

```typescript
const status = await client.getTaskStatus({ taskId: "abc-123" });

console.log(status.status); // "COMPLETED"
console.log(status.output); // '{"result":"success"}'
console.log(status.error); // null (if successful)
```

---

### CancelTask

Cancel a pending or running task.

**Request:**

```protobuf
message CancelTaskRequest {
  // Task ID to cancel (required)
  string task_id = 1;
}
```

**Response:**

```protobuf
message CancelTaskResponse {
  // Whether the cancellation succeeded
  bool success = 1;
}
```

**Example:**

```typescript
const result = await client.cancelTask({ taskId: "abc-123" });

if (result.success) {
  console.log("Task cancelled");
} else {
  console.log("Task already completed/failed/cancelled");
}
```

---

### GetStep (Internal)

Check if a step has been completed (used by SDK for memoization).

**Request:**

```protobuf
message GetStepRequest {
  // Task ID
  string task_id = 1;

  // Step key (e.g., "book-flight")
  string step_key = 2;
}
```

**Response:**

```protobuf
message GetStepResponse {
  // Whether step exists
  bool found = 1;

  // Whether step completed successfully
  bool completed = 2;

  // Step output if completed (JSON bytes)
  bytes output = 3;
}
```

---

### CompleteStep (Internal)

Mark a step as completed with output (used by SDK).

**Request:**

```protobuf
message CompleteStepRequest {
  string task_id = 1;
  string step_key = 2;
  bytes output = 3;  // JSON-encoded
}
```

**Response:**

```protobuf
message CompleteStepResponse {
  bool success = 1;
}
```

---

### FailStep (Internal)

Mark a step as failed (used by SDK).

**Request:**

```protobuf
message FailStepRequest {
  string task_id = 1;
  string step_key = 2;
  bytes error = 3;  // JSON-encoded error
}
```

**Response:**

```protobuf
message FailStepResponse {
  bool success = 1;
}
```

---

## TaskStatus Enum

```protobuf
enum TaskStatus {
  TASK_STATUS_UNSPECIFIED = 0;
  PENDING = 1;              // Waiting in queue
  RUNNING = 2;              // Currently executing
  COMPLETED = 3;            // Finished successfully
  FAILED = 4;               // Failed with error
  CANCELLED = 5;            // Manually cancelled
  ROLLED_BACK = 6;          // All compensations succeeded
  PARTIAL_ROLLBACK = 7;     // Some compensations failed
}
```

| Status             | Description                             |
| ------------------ | --------------------------------------- |
| `PENDING`          | Task submitted, waiting to be picked up |
| `RUNNING`          | Worker currently executing the workflow |
| `COMPLETED`        | Workflow finished successfully          |
| `FAILED`           | Workflow failed (step error, not saga)  |
| `CANCELLED`        | Manually cancelled                      |
| `ROLLED_BACK`      | All saga compensations succeeded        |
| `PARTIAL_ROLLBACK` | Some compensations failed (check DLQ)   |

---

## HealthService

Standard gRPC health checking protocol.

### Check

Get health status of the service.

**Request:**

```protobuf
message HealthCheckRequest {
  // Optional: specific service name
  string service = 1;
}
```

**Response:**

```protobuf
message HealthCheckResponse {
  enum ServingStatus {
    UNKNOWN = 0;
    SERVING = 1;
    NOT_SERVING = 2;
  }

  ServingStatus status = 1;
}
```

**Example:**

```bash
grpcurl localhost:50051 grpc.health.v1.Health/Check
```

---

### Watch

Stream health status updates.

**Request:** Same as Check

**Response:** Stream of HealthCheckResponse

---

## Using with grpcurl

### Submit a Task

```bash
grpcurl -d '{
  "workflowName": "order-processing",
  "input": "{\"orderId\": \"123\"}"
}' localhost:50051 duraflow.AgentService/SubmitTask
```

### Get Task Status

```bash
grpcurl -d '{"taskId": "abc-123"}' \
  localhost:50051 duraflow.AgentService/GetTaskStatus
```

### Cancel Task

```bash
grpcurl -d '{"taskId": "abc-123"}' \
  localhost:50051 duraflow.AgentService/CancelTask
```

### Check Health

```bash
grpcurl localhost:50051 grpc.health.v1.Health/Check
```

### List All Services

```bash
grpcurl localhost:50051 list
```

---

## Error Handling

### gRPC Status Codes

| Code                  | Meaning                 | Use Case                               |
| --------------------- | ----------------------- | -------------------------------------- |
| `OK`                  | Success                 | Normal responses                       |
| `INVALID_ARGUMENT`    | Missing/invalid input   | Invalid workflow name, malformed input |
| `NOT_FOUND`           | Task not found          | Invalid task ID                        |
| `FAILED_PRECONDITION` | Can't perform operation | Cancel already-completed task          |
| `INTERNAL`            | Server error            | Unexpected errors                      |

### Error Response Format

When a task fails, the error is stored as JSON:

```json
{
  "message": "Step failed: Payment declined",
  "name": "Error",
  "stack": "Error: Payment declined\n    at..."
}
```

---

## Code Examples

### TypeScript Client

```typescript
import { AgentServiceClient, credentials } from "@duraflow/proto";
import { taskStatus } from "@duraflow/proto";

const client = new AgentServiceClient(
  "localhost:50051",
  credentials.createInsecure(),
);

// Submit
const { taskId } = await client.submitTask({
  workflowName: "my-workflow",
  input: JSON.stringify({ data: "test" }),
});

// Poll for completion
async function waitForCompletion(taskId: string) {
  while (true) {
    const status = await client.getTaskStatus({ taskId });

    if (status.status === taskStatus.COMPLETED) {
      return JSON.parse(status.output!.toString());
    }

    if (status.status === taskStatus.FAILED) {
      throw new Error(JSON.parse(status.error!.toString()).message);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}

const result = await waitForCompletion(taskId);
console.log("Result:", result);
```

### Python Client

```python
import grpc
import duraflow_pb2
import duraflow_pb2_grpc

channel = grpc.insecure_channel('localhost:50051')
stub = duraflow_pb2_grpc.AgentServiceStub(channel)

# Submit
response = stub.SubmitTask(duraflow_pb2.SubmitTaskRequest(
    workflow_name="my-workflow",
    input=b'{"data": "test"}'
))

# Get status
status = stub.GetTaskStatus(duraflow_pb2.GetTaskStatusRequest(
    task_id=response.task_id
))

print(status.status)  # COMPLETED, FAILED, etc.
```
