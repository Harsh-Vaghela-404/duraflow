# Duraflow

**Durable workflow engine that makes AI agents crash-proof.** Wrap your agent in
`step.run()`, get checkpointing, retries, and saga rollbacks for free.

**Status:** Phase 1 - the core engine - is shipped and tested; the Python SDK and rate
limiting also shipped. Right now this is a durable job queue with sagas, not yet a
durable-execution engine - deterministic replay is what closes that gap, and it's the
next thing being built. See [Roadmap - Deep Engine Features](#roadmap--deep-engine-features)
below, and [product/status.md](product/status.md) for the honest line-item state.

---

## The Problem

AI agents run for minutes to hours. They call expensive LLMs, book hotels, charge cards, send emails. Any one of a dozen things can interrupt them mid-flight - a server restart, an API timeout, a rate limit, a network hiccup. When an agent crashes after step 7 of 10, traditional infrastructure has one answer: start over. The tokens you paid for, the work you already did - gone.

## The Solution

Duraflow is a durable workflow engine designed for the shape of AI work. You wrap your agent code in `step.run(...)`. Duraflow handles everything else:

- **Checkpoints every step** to Postgres so crashes don't lose progress
- **Resumes from the last completed step** when the worker restarts
- **Memoizes results** - completed steps return cached output on retry, no double LLM bills
- **Rolls back automatically** in LIFO order when a later step fails (saga pattern)
- **Routes failed compensations** to a dead-letter queue for operator inspection

```typescript
import { workflow } from '@duraflow/sdk';

export const researchAgent = workflow(
    'research-agent',
    async ({ step, input }) => {
        const results = await step.run('search', async () => {
            return await searchTheWeb(input.topic);
        });

        const summary = await step.run(
            'summarize',
            async () => {
                return await openai.summarize(results);
            },
            { retries: 3 },
        );

        await step.run('save', async () => {
            return await db.insert(summary);
        });

        return summary;
    },
    {
        // Compensations are pure functions of a step's saved output. If a later step
        // fails, completed steps are undone automatically in LIFO order (saga rollback).
        compensations: {
            save: async (saved) => {
                await db.delete(saved.id);
            },
        },
    },
);
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

The engine binds gRPC on `localhost:50051` (insecure credentials - trusted-network deployment for now). Use `grpcurl` to talk to it:

```bash
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
```

**Full developer docs:** [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app)

---

## What's Built

**Phase 1 - core engine, shipped:** a durable task queue on PostgreSQL (`FOR UPDATE SKIP LOCKED`,
atomic and multi-worker safe), step memoization keyed on `(task_id, step_key)`, saga
compensation with LIFO rollback and a dead-letter queue for failed compensations,
heartbeat + reaper for stale-task recovery, Redis leader election (`SET NX EX` + Lua
check-and-renew) so exactly one reaper runs, a Piscina worker thread pool so workflow
execution stays off the gRPC event loop, backpressure on queue depth and event-loop lag,
exponential-backoff retry, and superjson serialization (`Date`/`Map`/`Set`/`Error`
round-trip, 1 MB cap per payload). Covered by a three-tier test suite - 16 suites, 72
tests. Public docs at [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app).

**Also shipped:** a Python SDK (`packages/python-sdk`) at feature parity with the
TypeScript SDK over the external-worker gRPC RPCs, and Redis token-bucket rate limiting
with per-API presets (OpenAI/Anthropic) integrated into `step.run`.

---

## Roadmap - Deep Engine Features

The next chapter isn't more breadth (adapters, wrappers, CLIs) - it's **depth**. These are the hard distributed-systems features that define a real durable-execution engine, built by hand, in this order:

| #   | Feature                                          | What it unlocks                                                                                         |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | **Durable timers** (`ctx.sleep`)                 | Suspend a run to the DB and resume after a delay - survives an engine restart                           |
| 2   | **Deterministic replay** (event-sourced history) | Rebuild run state by folding an append-only event log; crash-resume with no recompute - the crown jewel |
| 3   | **Signals / wait-for-event**                     | Block a run until an external event arrives (human-in-loop without a dashboard)                         |
| 4   | **Child workflows + parallel steps**             | Composition, fan-out / fan-in, dependency graphs                                                        |
| 5   | **Workflow versioning**                          | Run in-flight executions on old code while new submissions use new code                                 |
| 6   | **Horizontal sharding**                          | Partition dispatch across N nodes - scale past one engine                                               |
| 7   | **Exactly-once side effects**                    | Idempotency keys so a retried step can't double-charge                                                  |
| 8   | **OpenTelemetry + Prometheus**                   | Traces across the step boundary; queue-depth / lag / task metrics                                       |
| 9   | **Load benchmark harness**                       | 10k-task throughput + p99 latency numbers                                                               |
| 10  | **Read-only runs dashboard**                     | Runs list + step timeline - makes the engine demoable                                                   |

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
- **Redis** is intentionally narrow - distributed leader election only. No generic caching.
- **Piscina** worker thread pool runs the workflow code so the gRPC server stays responsive.
- **gRPC** is the transport (`@grpc/grpc-js` 1.9), with reflection enabled for `grpcurl`.
- **superjson** preserves rich types through serialization with a 1 MB cap per payload.

For a deeper dive, see [product/status.md](product/status.md) for the current line-item state of every piece above.

---

## Project Structure

```
duraflow/
├── apps/
│   └── engine/                - gRPC server, poller, workers, repositories, services
├── packages/
│   ├── sdk/                   - @duraflow/sdk: workflow, step.run, compensation, serialize
│   ├── proto/                 - gRPC protobuf definitions + ts-proto generated types
│   └── typescript-config/     - Shared tsconfig bases
├── docs/                      - VitePress site (published to Vercel)
├── product/                   - Honest current state (status.md) + phased delivery plan (roadmap.md)
└── docker-compose.yml         - Local infra (postgres:16, redis:7, qdrant)
```

`apps/dashboard/` exists as an empty placeholder for the Phase 3 dashboard. Qdrant is provisioned in `docker-compose.yml` for future vector-memory features but is not wired into the engine yet.

---

## Documentation

| Audience                        | Read                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| **Evaluating Duraflow**         | [product/status.md](product/status.md) - honest current state                              |
| **Planning around the roadmap** | [product/roadmap.md](product/roadmap.md) - phased delivery plan                            |
| **Building with Duraflow**      | [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app) - installation, tutorial, API |

---

## On the Postgres Choice

Adding a Kafka cluster or a Temporal persistence stack for this is more operational surface than most teams building an AI feature want to take on. Postgres + `FOR UPDATE SKIP LOCKED` is a battle-tested queue pattern (Stripe and Sidekiq Pro both use variants of it), JSONB is good enough for step payloads, and most teams already run Postgres anyway - one database, one set of backups. Redis is the only other dependency, and it does exactly one job: leader election.

---

## Contributing

This is a young project. The fastest way to help:

1. **Try it.** Clone, run, build a workflow. File issues for anything confusing.
2. **PRs welcome** for: more test coverage, fixing the known issues listed in [product/status.md](product/status.md), and anything on the roadmap above.

Conventional commits, feature branches off `main`.

---

## License

[MIT](LICENSE) - use it however you want, including commercially. Attribution appreciated, not required.
