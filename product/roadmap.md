# Roadmap

> What's shipped, what's next, and what's later. We commit to **ordering**, not to **dates**.

We will not promise quarters. AI infrastructure moves faster than any 14-week plan survives. Instead, this file commits to the order of work: each phase ships before the next starts.

For the precise current state (file paths, what's-in-code), see [status.md](status.md).

---

## Phase 1 — The Engine [SHIPPED]

**Goal:** Make `step.run(...)` actually durable. Build the smallest engine that supports crash recovery, sagas, and exactly-once semantics on Postgres.

### Delivered
- Durable task queue on Postgres with `FOR UPDATE SKIP LOCKED`
- Poller with exponential backoff and backpressure
- Heartbeat service + reaper for dead-worker recovery
- Redis leader election (singleton reaper across the cluster)
- Piscina worker thread pool with main-thread IPC
- TypeScript SDK: `workflow`, `step.run`, retries, compensation
- LIFO saga compensation with per-step timeouts
- Dead-letter queue for failed compensations
- superjson serialization with 1 MB cap
- Three-tier test suite (unit / integration / e2e)
- Public VitePress docs site

### Outcome
The engine is production-capable for early adopters running it on a trusted network. A new user can clone the repo, run `docker compose up`, and ship a durable agent within an afternoon.

---

## Phase 2 — SDK Ecosystem [NEXT]

**Goal:** Make Duraflow easy to *adopt*. The engine works; now meet developers where they are.

### Python SDK
- `pip install duraflow`
- Feature parity with the TypeScript SDK: `@workflow` decorator, `ctx.step.run(...)`, retries, compensation
- Generated gRPC client from the proto
- Pydantic integration for typed step inputs and outputs
- Same idempotency and crash-recovery semantics

### Framework Adapters
- **LangChain adapter** — `duraflow.wrap(chain)` to make any LangChain agent durable
- **CrewAI adapter** — `duraflow.wrap(crew)` for CrewAI users
- Each adapter is a thin shim that maps the framework's call graph onto `step.run`, preserving framework ergonomics while adding durability underneath

### REST API + Webhooks
- Express wrapper that exposes `SubmitTask` / `GetTaskStatus` / `CancelTask` over HTTP for callers that can't or won't speak gRPC
- Webhook triggers (an HTTP `POST` becomes a `SubmitTask`)
- Scheduled / cron triggers
- OpenAPI spec + Swagger UI for the REST surface

### CLI
- `duraflow init` — scaffolds a new project
- `duraflow dev` — runs the engine locally with hot-reload of workflow files
- `duraflow deploy` — pushes workflows to a Duraflow Cloud instance (when hosted launches)
- `duraflow runs <task-id>` — show a run's step history
- `duraflow logs <task-id>` — tail logs for a run

### Rate Limiting
- Redis token-bucket implementation
- Per-API presets for OpenAI and Anthropic
- `step.run` integrates with rate limits so a saturated provider pauses the bucket, not the whole queue

### Why this phase next
Adoption is the gating constraint. Every feature in Phase 3+ depends on people actually running Duraflow.

---

## Phase 3 — Dashboard, Cost, and Human-in-Loop [LATER]

**Goal:** Make Duraflow *observable* and *operable* — not just by developers but by ops, finance, and humans in the loop.

### Dashboard (React)
- Runs list with status filters and search
- Run detail page with step timeline visualization
- Per-step input / output / error inspection
- Real-time log streaming
- Responsive layout (works on a phone for on-call response)

### Cost Tracking
- `tokens` column on `step_runs` (input / output / total)
- `cost_usd` derived column based on per-model rates
- Per-workflow / per-run cost dashboards
- Budget alerts and per-tenant quotas

### Human-in-Loop
- New `approval_requests` table
- `ctx.waitForApproval({ approver, timeout })` SDK API
- Approval dashboard page where designated humans can approve / reject
- Notification integrations (Slack, email) for pending approvals

### Notifications
- Slack integration (run complete / failed / awaiting approval)
- Webhook outbound for arbitrary downstream systems

### Why this phase next
By Phase 3, real users exist and want to *see* what's happening. The dashboard is also the most viral marketing asset Duraflow has — a screen recording of a live workflow timeline sells the product more effectively than any landing page copy.

---

## Phase 4 — Time Travel + Launch [LATER]

**Goal:** Make Duraflow's killer differentiator real and ship a v1.0 launch.

### Time-Travel Debugging
- Fork-a-run: clone the persisted state of a run at any point
- Modify the input or the workflow code
- Replay downstream steps without re-paying for already-completed steps
- UI for "step diff" — see exactly what changed between a forked run and the original

### Production Hardening
- TLS support for gRPC
- Authentication layer (JWT / API key via Metadata interceptor)
- Multi-tenancy (row-level security in Postgres, per-tenant API keys)
- OpenTelemetry integration (traces export)
- Prometheus metrics endpoint
- Structured JSON logging option (alongside the current TAG-prefixed `console.log`)

### Launch
- 5-minute "zero to hero" tutorial
- 90-second hero video (record an agent crashing and resuming)
- Comparison page vs Temporal / Trigger.dev / Inngest / LangChain
- Product Hunt submission
- Hacker News "Show HN" post
- Conference / podcast outreach

### Why this phase last
Time-travel debugging is the feature that justifies a marketing push. The launch only matters once Phases 1-3 are stable enough that early adopters won't churn during the rush.

---

## Beyond v1.0

These are credible directions, not commitments. The order shuffles based on what real users ask for.

### Integrations
- **AutoGen** adapter
- **MCP** (Model Context Protocol) integration — make Duraflow a durable host for MCP tool calls
- **n8n** / **Zapier** triggers
- **Qdrant** memory primitives (Qdrant is already in `docker-compose.yml` — wiring it up to a `ctx.memory.recall(...)` API is the next step)

### Scale
- Queue sharding (separate `agent_tasks` partitions per workflow or per tenant)
- Postgres read replicas for the dashboard
- S3 archiving for completed runs older than N days

### Enterprise
- SSO (SAML / OIDC)
- RBAC permission model
- Audit log table + UI
- Self-hosted SDK with remote runtime
- SLA tier on Duraflow Cloud

### AI-Specific
- A/B model testing (run the same step against GPT-4 and Claude, compare outputs)
- Prompt versioning (git-like history on the prompts inside steps)
- Cost prediction (estimate a workflow's cost before running it)

### Adjacent Products
- **AI Accountability** — a universal audit layer that works with Duraflow, Temporal, LangChain, or anything else. See [future-products/ai-accountability.md](future-products/ai-accountability.md). This is a *separate* product, not a Duraflow feature, but the same team is positioned to build it.

---

## What's Explicitly Out of Scope

- **A chat framework.** Duraflow runs underneath LangChain / CrewAI / your own code. It does not compete with them.
- **A general-purpose workflow engine.** Temporal is excellent at that. We are AI-shaped on purpose.
- **A logs vendor.** We persist enough state to debug a single run. For aggregate logging, integrate with Datadog / Honeycomb / Loki.
- **A model gateway.** We don't proxy LLM calls or pick the cheapest model. We make whatever you call durable.
