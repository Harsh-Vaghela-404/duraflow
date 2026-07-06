# Duraflow

<p align="center">
  <strong>Durable workflow engine that makes AI agents crash-proof.</strong><br>
  Wrap your agent in <code>step.run()</code>, get checkpointing, retries, and saga rollbacks for free.
</p>

<p align="center">
  <a href="https://duraflow-docs.vercel.app">
    <img src="https://img.shields.io/badge/Docs-Live-brightgreen" alt="Documentation">
  </a>
  <a href="product/status.md">
    <img src="https://img.shields.io/badge/Status-Phase%201%20shipped-blue" alt="Status">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License">
  </a>
  <img src="https://img.shields.io/badge/Node-%3E%3D18-339933.svg?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6.svg?logo=typescript&logoColor=white" alt="TypeScript">
</p>

> **Status:** Phase 1 — the core engine — is **shipped and tested**; the Python SDK and rate limiting also shipped. The active roadmap is a hand-built deepening of the engine's distributed-systems core — durable timers, deterministic replay, signals, child workflows, versioning, and more. See [Roadmap — Deep Engine Features](#roadmap--deep-engine-features) below, and [product/status.md](product/status.md) for the honest line-item state.

---

## The Problem

AI agents run for minutes to hours. They call expensive LLMs, book hotels, charge cards, send emails. Any one of a dozen things can interrupt them mid-flight — a server restart, an API timeout, a rate limit, a network hiccup. When an agent crashes after step 7 of 10, traditional infrastructure has one answer: start over. The tokens you paid for, the work you already did — gone.

## The Solution

Duraflow is a durable workflow engine designed for the shape of AI work. You wrap your agent code in `step.run(...)`. Duraflow handles everything else:

- **Checkpoints every step** to Postgres so crashes don't lose progress
- **Resumes from the last completed step** when the worker restarts
- **Memoizes results** — completed steps return cached output on retry, no double LLM bills
- **Rolls back automatically** in LIFO order when a later step fails (saga pattern)
- **Routes failed compensations** to a dead-letter queue for operator inspection

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
  // fails, completed steps are undone automatically in LIFO order (saga rollback).
  compensations: {
    save: async (saved) => {
      await db.delete(saved.id);
    },
  },
});
```

That's the whole API. Wrap each unit of work in `step.run`. Declare a `compensation` per step key for steps that must be undone when a later step fails.

---

## Quick Start

**Requirements:** Node ≥18, Docker (for Postgres + Redis).

```bash
# 1. Clone the repo
git clone https://github.com/Harsh-Vaghela-404/duraflow
cd duraflow

# 2. Install dependencies
npm install

# 3. Start Postgres + Redis
docker compose up -d postgres redis

# 4. Configure .env in apps/engine (see apps/engine/.env.example if present)
# DATABASE_URL=postgresql://duraflow:duraflow@localhost:5433/duraflow
# REDIS_URL=redis://localhost:6379

# 5. Run migrations
npx tsx apps/engine/src/db/migrate.ts

# 6. Start the engine
npm run dev --workspace=@duraflow/engine
```

The engine binds gRPC on `localhost:50051` (insecure credentials — trusted-network deployment for now). Use `grpcurl` to talk to it:

```bash
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
```

**Full developer docs:** [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app)

---

## What's Built

### Phase 1 — Core Engine [SHIPPED]

- ✅ **Durable task queue** on PostgreSQL with `FOR UPDATE SKIP LOCKED` — atomic, lock-free, multi-worker safe
- ✅ **Step memoization** keyed on `(task_id, step_key)` — re-running a workflow skips already-completed steps
- ✅ **Saga compensation** with LIFO rollback over completed steps
- ✅ **Dead-letter queue** for failed compensations — operator retries via `dlqRepo.retry(id)`
- ✅ **Heartbeat + Reaper** — dead workers don't leak tasks; reaper recovers stale `running` tasks
- ✅ **Redis leader election** (SET NX EX + Lua check-and-renew) — singleton reaper across the cluster
- ✅ **Piscina worker thread pool** — workflow execution runs off the gRPC server's event loop
- ✅ **Backpressure** — queue size + event-loop lag thresholds pause ingestion when saturated
- ✅ **Exponential-backoff retry** with `StepRetryError`
- ✅ **superjson serialization** — `Date`, `Map`, `Set`, `Error` round-trip cleanly (1 MB cap per payload)
- ✅ **TypeScript SDK** (`@duraflow/sdk`): `workflow`, `step.run`, retries, compensation, serialize
- ✅ **Three-tier test suite**: 16 suites (unit / integration / e2e), 72 tests — all green
- ✅ **Public documentation site** at [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app)

### Also Shipped

- ✅ **Python SDK** — `@workflow` decorator, `StepRunner`, standalone worker over the external-worker gRPC RPCs (`packages/python-sdk`)
- ✅ **Rate limiting** — Redis token bucket with per-API presets (OpenAI / Anthropic), integrated into `step.run`

---

## Roadmap — Deep Engine Features

The next chapter isn't more breadth (adapters, wrappers, CLIs) — it's **depth**. These are the hard distributed-systems features that define a real durable-execution engine, built by hand, in this order:

| # | Feature | What it unlocks |
|---|---|---|
| 1 | **Durable timers** (`ctx.sleep`) | Suspend a run to the DB and resume after a delay — survives an engine restart |
| 2 | **Deterministic replay** (event-sourced history) | Rebuild run state by folding an append-only event log; crash-resume with no recompute — the crown jewel |
| 3 | **Signals / wait-for-event** | Block a run until an external event arrives (human-in-loop without a dashboard) |
| 4 | **Child workflows + parallel steps** | Composition, fan-out / fan-in, dependency graphs |
| 5 | **Workflow versioning** | Run in-flight executions on old code while new submissions use new code |
| 6 | **Horizontal sharding** | Partition dispatch across N nodes — scale past one engine |
| 7 | **Exactly-once side effects** | Idempotency keys so a retried step can't double-charge |
| 8 | **OpenTelemetry + Prometheus** | Traces across the step boundary; queue-depth / lag / task metrics |
| 9 | **Load benchmark harness** | 10k-task throughput + p99 latency numbers |
| 10 | **Read-only runs dashboard** | Runs list + step timeline — makes the engine demoable |

Depth over breadth: a general-purpose durable-execution engine with a distributed-systems core you can defend line by line.

---

## Architecture

```
Client ──gRPC──> Duraflow Engine ──Piscina workers──> Your Workflow Code
                       │
                       ├──> PostgreSQL   (agent_tasks, step_runs, dead_letter_queue)
                       └──> Redis        (leader election for the reaper)
```

- **PostgreSQL** is the source of truth. Raw `pg` (no ORM). `FOR UPDATE SKIP LOCKED` is the queue primitive.
- **Redis** is intentionally narrow — distributed leader election only. No generic caching.
- **Piscina** worker thread pool runs the workflow code so the gRPC server stays responsive.
- **gRPC** is the transport (`@grpc/grpc-js` 1.9), with reflection enabled for `grpcurl`.
- **superjson** preserves rich types through serialization with a 1 MB cap per payload.

For a deeper dive, see [knowledge-base/ARCHITECTURE.md](knowledge-base/ARCHITECTURE.md) (module-by-module reference) and [knowledge-base/FLOWS.md](knowledge-base/FLOWS.md) (end-to-end flows like submit, execute, retry, rollback, reap).

---

## Project Structure

```
duraflow/
├── apps/
│   └── engine/                — gRPC server, poller, workers, repositories, services
├── packages/
│   ├── sdk/                   — @duraflow/sdk: workflow, step.run, compensation, serialize
│   ├── proto/                 — gRPC protobuf definitions + ts-proto generated types
│   └── typescript-config/     — Shared tsconfig bases
├── docs/                      — VitePress site (published to Vercel)
├── product/                   — Product story (overview, vision, status, roadmap)
├── knowledge-base/            — Codebase reference (architecture, patterns, gotchas)
└── docker-compose.yml         — Local infra (postgres:16, redis:7, qdrant)
```

`apps/dashboard/` exists as an empty placeholder for the Phase 3 dashboard. Qdrant is provisioned in `docker-compose.yml` for future vector-memory features but is not wired into the engine yet.

---

## Documentation

| Audience | Read |
|---|---|
| **First-time visitor** | [product/overview.md](product/overview.md) — 5-minute pitch |
| **Evaluating Duraflow** | [product/status.md](product/status.md) — honest current state |
| **Planning around the roadmap** | [product/roadmap.md](product/roadmap.md) — phased delivery plan |
| **Deeper context / vision** | [product/vision.md](product/vision.md) — long-form vision |
| **Building with Duraflow** | [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app) — installation, tutorial, API |
| **Working on the code** | [knowledge-base/](knowledge-base/) — architecture, patterns, gotchas, flows |

---

## Why Postgres, Not Kafka / Temporal / Redis Streams

Every AI team already runs Postgres. Adding a Kafka cluster, a Temporal persistence stack, or a separate Redis-backed state store is operational overhead that kills adoption for small teams.

Postgres + `FOR UPDATE SKIP LOCKED` is a battle-tested queue (used by Stripe, Sidekiq Pro, and many others). JSONB handles step payloads. One database, one source of truth, one set of backups. Duraflow stays small on purpose: PostgreSQL for state, Redis for one specific job (leader election), nothing else mandatory.

---

## Contributing

This is a young project. The fastest way to help:

1. **Try it.** Clone, run, build a workflow. File issues for anything confusing.
2. **Read [knowledge-base/GOTCHAS.md](knowledge-base/GOTCHAS.md)** before touching code — there are conventions (the `TAG` logging pattern, `FOR UPDATE SKIP LOCKED` as the queue primitive, no generic Redis caching, etc.) that you'll want to know up front.
3. **PRs welcome** for: more test coverage, fixing the known issues listed in [product/status.md](product/status.md), and anything on the roadmap above.

Conventional commits, feature branches off `main`. See [knowledge-base/](knowledge-base/) for the full developer-facing conventions.

---

## License

[MIT](LICENSE) — use it however you want, including commercially. Attribution appreciated, not required.

---

<p align="center">
  Built for AI teams that need durability today and don't want to operate Temporal.<br>
  <a href="https://duraflow-docs.vercel.app"><strong>Read the docs →</strong></a>
</p>
