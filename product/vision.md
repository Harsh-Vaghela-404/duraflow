# Vision

> Why Duraflow exists, what we believe about the future of AI infrastructure, and what we are building toward.

## The Bet

We believe the next decade of software will be defined by **autonomous, long-running agents** — programs that perceive a goal, plan a sequence of steps, call models and external systems to execute those steps, and produce an outcome over minutes, hours, or days.

That mode of computation breaks every assumption baked into existing infrastructure:

- **Job queues** assume work is short and stateless. Agent work is long and stateful.
- **HTTP servers** assume a request lives in a single process. Agent work outlives a process.
- **Workflow engines like Temporal** got the model right but were built for the enterprise back-office, not for an AI startup wiring an LLM into product on a Tuesday.
- **Agent frameworks like LangChain and CrewAI** got the developer ergonomics right but have no durability story — every framework's "production" page is a list of caveats.

We believe the missing piece is a **runtime that is purpose-built for the shape of agent workloads** and small enough to actually adopt. Not a Java service mesh. Not a separate team. A library you `npm install`, plus a process you run alongside Postgres.

That is Duraflow.

## What We Believe

### 1. Durability is a runtime concern, not a developer concern.

Every team that ships agents writes the same defensive code: retries, idempotency keys, checkpoint storage, compensation logic, dead-letter handling. It is the same code in every codebase, written badly under deadline pressure, with subtle bugs that show up in production at 3am.

This belongs in the runtime. The developer's job is `step.run("name", async () => doTheThing())`. The runtime's job is everything else.

### 2. Postgres is the right substrate.

Every AI team already runs Postgres. Adding Kafka, Temporal's persistence cluster, or a separate state store is operational overhead that kills adoption. Postgres + `FOR UPDATE SKIP LOCKED` is a battle-tested queue. JSONB is good enough for step payloads. One database, one source of truth, one set of backups.

Duraflow stays small on purpose: PostgreSQL for state, Redis for one specific job (leader election), nothing else mandatory.

### 3. Sagas belong in the framework, not as an exercise for the user.

If your agent books a flight, then a hotel, then the payment fails — every completed step needs to undo, in reverse order, with failures themselves logged for operator review. This is well-understood (it's the Saga pattern from 1987) and yet most agent frameworks leave it to the user.

Duraflow makes compensations a first-class step option. Failed compensations route to a dead-letter queue automatically. Operators get a row to inspect and a `retry(id)` to re-fire.

### 4. The cost story is the production story.

LLM calls are expensive. A workflow that crashes and restarts from scratch costs twice. A retry storm costs ten times. A runaway loop costs a thousand times.

Reliability is the cost story. Memoization is the cost story. Rate limiting is the cost story. Time-travel debugging — replaying from step 5 without paying for steps 1-4 — is the cost story. We will build features in that order.

### 5. Simplicity beats sophistication.

Temporal is technically superior to Duraflow on many axes. Duraflow will likely never close all those gaps. That is fine. Most teams choose `console.log` over OpenTelemetry not because OpenTelemetry is bad but because `console.log` ships today.

Duraflow's job is to be the obvious choice for a team that needs durability now and wants the operational surface to be "a process and a Postgres connection."

## Who We Are Building For

### The AI Startup

You shipped an LLM feature on a Friday. By Monday a customer reported it crashed halfway and ate $40 in OpenAI credits. You need durability today. You do not have the team to deploy Temporal.

Duraflow drops in over a weekend.

### The Agency / Consultancy

You run AI workflows for clients. Long ones. The ones that fail at the 90% mark are the ones that destroy your margin. You also can't sell "we lost your data because the server restarted" — your reputation is on the line.

Duraflow gives you a story: "every step is checkpointed; every failure has a compensation; every dropped task is reaped within five minutes."

### The Enterprise Team

You have compliance. You have ops. You have a CFO watching the GenAI line item. You need auditable, recoverable, rate-limited flows or you can't get past procurement.

Duraflow is small enough to self-host, opinionated enough to be understood, and structured enough to satisfy your CTO that the failure modes are bounded.

### The Open Source Developer

You're building an agent for fun or for portfolio. You want the experience of `step.run(...)` to feel as good as `useState`. You don't want to learn three new acronyms.

Duraflow's SDK is the developer surface we obsess over. Everything else exists to serve it.

## What We Are Building Toward

A world where:

- You can declare an agent's logic in plain code, with steps that look like ordinary `await`s.
- You can read a step's inputs, outputs, and errors from a dashboard the same way you'd read a database row.
- You can replay any agent run from any point — change a prompt, change a model, change the input, and re-execute downstream — without paying for steps you already paid for.
- You can hand a failed workflow's compensation history to a non-engineer operator and say "click retry."
- You can ship multi-step AI features without writing a single line of retry logic.

We are not there yet. The engine is built. The SDK is built. The docs are built. The dashboard, the cost-tracker, the time-travel debugger, the Python SDK, the LangChain/CrewAI adapters — those are the next year.

See [roadmap.md](roadmap.md) for the order.

## What Success Looks Like

Short term (next 6 months):
- A working hosted version of Duraflow that a new user can sign up for and ship an agent on the same afternoon.
- Python SDK at parity with TypeScript.
- Dashboard with runs list, step timeline, and cost view.
- At least one major open-source agent framework (LangChain or CrewAI) wrappable with a one-line adapter.
- Reference customers in two of: AI startup, agency, enterprise.

Long term (next 2-3 years):
- Duraflow is the default answer to "how do I run AI agents in production" the way Redis became the default answer for caching.
- A separate but adjacent product, **AI Accountability**, addresses the audit/compliance gap that emerges as AI moves into regulated industries (see [future-products/ai-accountability.md](future-products/ai-accountability.md)).
- An ecosystem of integrations — LangChain, CrewAI, AutoGen, n8n, Zapier, MCP, edge runtimes — that all talk to Duraflow as the durability layer.

## What We Will Not Do

We will not turn Duraflow into:

- **A general-purpose workflow engine.** Temporal is good at that. We are AI-shaped on purpose.
- **A vendor-lock-in platform.** The engine is open source. Self-hosting is supported. The hosted version is convenience, not coercion.
- **A chat framework.** We sit *under* chat frameworks; we don't compete with them.
- **A black-box managed service.** Every workflow's state lives in the user's Postgres. Operators can `SELECT *` and see exactly what's happening.

---

If this resonates, the right next reads are [overview.md](overview.md) (the headline pitch), [status.md](status.md) (what actually exists today), and [roadmap.md](roadmap.md) (the order of operations).
