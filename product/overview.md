# Duraflow

**The durable workflow engine that keeps AI agents running — through crashes, timeouts, and rollbacks.**

---

## The Problem

AI agents are powerful but fragile. They run for minutes or hours — researching, summarizing, calling APIs, generating content — and any one of a dozen things can interrupt them mid-flight:

- A server restarts
- An LLM API times out
- The network drops
- A rate limit is hit
- Memory is exhausted

When a multi-step agent crashes after step 7 of 10, traditional infrastructure has one answer: **start over.** All the LLM tokens you already paid for, all the work you already did — gone.

This is the reliability gap blocking AI from production.

## The Solution

Duraflow is a durable workflow engine designed for the shape of AI work — long-running, expensive, multi-step, partially-failing flows. You wrap your agent code in `step.run(...)`. Duraflow does the rest:

- **Checkpoints every step** to Postgres so a crash doesn't lose progress
- **Resumes from the last completed step** when the worker restarts
- **Guarantees each step runs at most once** via `(task_id, step_key)` idempotency keys
- **Rolls back automatically** in LIFO order when a later step fails (saga pattern)
- **Captures failed compensations** in a dead-letter queue for operator inspection

Your agents become crash-proof. Your costs stop spiraling when something goes wrong. Your ops team stops getting paged at 3am.

## How It Looks in Code

```typescript
import { workflow } from "@duraflow/sdk";

export const researchAgent = workflow("research-agent", async ({ step, input }) => {
  const results = await step.run("search", async () => {
    return await searchTheWeb(input.topic);
  });

  const summary = await step.run("summarize", async () => {
    return await openai.summarize(results);
  }, { retries: 3 });

  await step.run("save", async () => {
    return await db.insert(summary);
  });

  return summary;
}, {
  // Compensations are pure functions of a step's saved output. If a later step
  // fails, completed steps are undone automatically in LIFO order.
  compensations: {
    save: async (saved) => {
      await db.delete(saved.id);
    },
  },
});
```

That's the whole API. Wrap each unit of work in `step.run`. Declare a `compensation` per step key for steps that must be undone when a later step fails.

## What It Gives You

| Without Duraflow | With Duraflow |
|---|---|
| Crashes restart workflows from scratch | Resumes from the last completed step |
| Retries re-run steps you already paid for | Memoized — completed steps return cached output |
| Failed multi-step flows leave inconsistent state | LIFO compensation undoes completed work |
| Long-running flows compete for the same task across workers | `FOR UPDATE SKIP LOCKED` claims tasks atomically |
| Dead workers leak tasks forever | Reaper recovers stale tasks (singleton via Redis leader election) |
| LLM cost spikes burn budgets silently | Backpressure pauses ingestion when the system is saturated |
| Stack traces tell you nothing about agent behavior | Every step persists `input`, `output`, `error` for inspection |

## Architecture, in 90 Seconds

```
Client ──gRPC──> Duraflow Engine ──Piscina workers──> Your Workflow Code
                       │
                       ├──> Postgres   (agent_tasks, step_runs, dead_letter_queue)
                       └──> Redis      (leader election for the reaper)
```

- **gRPC** for the API. `@grpc/grpc-js`. Insecure today; trusted-network deployment.
- **PostgreSQL** as the source of truth. Raw `pg` (no ORM). `FOR UPDATE SKIP LOCKED` is the queue primitive.
- **Piscina** worker thread pool runs the actual workflow code so the gRPC server stays responsive.
- **Redis** is only for distributed leader election — not generic caching.
- **superjson** preserves `Date` / `Map` / `Set` / `Error` through serialization (1 MB hard cap per payload).
- **TypeScript SDK** is the primary developer surface (`@duraflow/sdk`). A **Python SDK** ships too (`packages/python-sdk`), running as an external worker over gRPC.

## Who Duraflow Is For

- **AI startups** shipping multi-step agent features and tired of writing checkpointing code.
- **Agencies** running long agents for clients and tired of explaining why a 2-hour task restarted at 1h 50m.
- **Enterprise teams** running AI in production and needing auditable, recoverable, rate-limited flows.
- **Anyone** who looked at Temporal, agreed with the concept, and concluded the JVM-heavy operational surface was too much for an AI feature.

## What Duraflow Is *Not*

- **Not a chat framework.** It is below LangChain / CrewAI / your custom agent — it runs them durably. Adapters for popular frameworks are on the roadmap.
- **Not a job queue.** A job queue runs a function; Duraflow runs a multi-step, resumable, compensable workflow.
- **Not Temporal.** Temporal is excellent and battle-tested. Duraflow is simpler, AI-shaped, and TS/Postgres-native rather than JVM/multi-store.

## Current State

**Phase 1 (the engine) is shipped.** Durable workflows, sagas, dead-letter queue, reaper, leader election, worker threads, backpressure — all live in code with three-tier tests. Public documentation is published at [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app).

**Phase 2 (SDK ecosystem)** is in progress: the Python SDK and rate limiting are shipped; LangChain & CrewAI adapters, REST, and CLI are next.

**Phase 3 (dashboard + cost + human-in-loop)** follows.

See [status.md](status.md) for the honest line-item state and [roadmap.md](roadmap.md) for what's coming.

## Get Started

```bash
# Today: clone and run the engine locally
git clone https://github.com/Harsh-Vaghela-404/duraflow
cd duraflow
docker compose up -d postgres redis
npm install
npx tsx apps/engine/src/db/migrate.ts
npm run dev --workspace=@duraflow/engine
```

Public npm packages, hosted cloud, and a `duraflow init` CLI are part of Phase 2.

---

**Write your agent. Duraflow keeps it running.**
