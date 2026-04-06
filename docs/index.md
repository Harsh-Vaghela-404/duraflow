# Getting Started with Duraflow

Duraflow is a **durable workflow engine** that ensures your workflows complete reliably, even after crashes. It combines crash recovery with the saga pattern for automatic rollback.

## Why Duraflow?

| Problem                               | Duraflow Solution                         |
| ------------------------------------- | ----------------------------------------- |
| Workflow crashes mid-execution        | Resume from last successful step          |
| Partial failure in multi-step process | Automatic rollback via saga pattern       |
| Multiple workers competing for tasks  | SKIP LOCKED prevents duplicate processing |
| Worker dies while processing          | Reaper recovers stale tasks               |
| API rate limits                       | Built-in rate limiting support            |

## Installation

```bash
# Install SDK and proto
npm install @duraflow/sdk @duraflow/proto

# Or for development
npm install -D @duraflow/sdk @duraflow/proto
```

## Quick Start

### 1. Define a Workflow

```typescript
import { workflow } from "@duraflow/sdk";

const greetingWorkflow = workflow("greeting", async (ctx) => {
  const result = await ctx.step.run("create-greeting", async () => {
    const name = (ctx.input as { name: string }).name;
    return `Hello, ${name}!`;
  });

  return { message: result };
});
```

### 2. Start the Engine

```bash
# Using Docker Compose for dependencies
docker-compose up -d

# Start the engine
npm run dev
```

### 3. Submit a Task

```typescript
import { AgentServiceClient, credentials } from "@duraflow/proto";

const client = new AgentServiceClient(
  "localhost:50051",
  credentials.createInsecure(),
);

const response = await client.submitTask({
  workflowName: "greeting",
  input: JSON.stringify({ name: "World" }),
});

console.log("Task ID:", response.taskId);
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Duraflow Engine                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│  │  Poller  │───▶│ Executor  │───▶│  Worker   │             │
│  └──────────┘    └──────────┘    └──────────┘             │
│       │               │               │                     │
│       ▼               ▼               ▼                     │
│  ┌─────────────────────────────────────────────┐           │
│  │           PostgreSQL Database               │           │
│  │  - agent_tasks (workflow runs)               │           │
│  │  - step_runs (step checkpoints)             │           │
│  │  - dead_letter_queue (failed comps)          │           │
│  └─────────────────────────────────────────────┘           │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Reaper    │  │  Heartbeat  │  │  Leader     │        │
│  │ (recovery)  │  │  (monitor)  │  │ (election)  │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
│                        │                                    │
│                        ▼                                    │
│              ┌─────────────────┐                            │
│              │     Redis       │                            │
│              │ - Rate limiting │                           │
│              │ - Leader lock   │                            │
│              └─────────────────┘                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

### 1. Crash Recovery

Every step's output is automatically saved. On crash, the workflow resumes from the last successful step.

### 2. Saga Pattern

Add compensation functions to automatically rollback when failures occur.

### 3. Multi-Worker Support

Multiple workers can process tasks concurrently without duplicate processing (SKIP LOCKED).

### 4. Automatic Recovery

Dead workers are detected via heartbeat, and their tasks are requeued automatically.

### 5. Rate Limiting

Built-in support for API rate limits (coming soon).

---

## Next Steps

- [Installation Guide](./installation) - Set up your environment
- [Quick Start Tutorial](./tutorial) - Build your first workflow
- [Core Concepts](./concepts) - Understand how Duraflow works
- [API Reference](./api/overview) - Full API documentation
