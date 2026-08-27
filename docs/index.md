# Getting Started with Duraflow

Duraflow is a **durable workflow engine** that ensures your workflows complete reliably, even after crashes. It combines crash recovery with the saga pattern for automatic rollback.

If a worker dies mid-run, the workflow picks up from the last completed step instead
of starting over. If a step fails after others already ran, their compensations undo
what already happened, in reverse order. That's the whole pitch.

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

## Architecture

The engine takes work off a Postgres queue (`FOR UPDATE SKIP LOCKED`, so multiple
workers can dequeue concurrently without stepping on each other) and runs it in a
Piscina worker pool, off the gRPC server's event loop. Every step's output goes into
`step_runs` before the workflow moves on, which is what makes crash recovery and
saga rollback possible - a restart just re-reads that table. Redis's only job is
leader election, so exactly one reaper process recovers stale tasks at a time.

Crash recovery, the saga pattern, multi-worker safety, and rate limiting are all
consequences of that one design choice (Postgres as the source of truth), not
separate features bolted on top.

Next: [Installation](./installation), then [your first workflow](./tutorial).
