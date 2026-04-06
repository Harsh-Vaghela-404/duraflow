# Duraflow

<p align="center">
  <strong>Durable execution engine for AI agents. Crash-proof workflows with automatic rollbacks.</strong>
</p>

<p align="center">
  <a href="https://duraflow-docs.vercel.app">
    <img src="https://img.shields.io/badge/Docs-Live-brightgreen" alt="Documentation">
  </a>
  <a href="https://github.com/your-org/duraflow/actions">
    <img src="https://img.shields.io/github/actions/status/your-org/duraflow/main" alt="Build">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/your-org/duraflow" alt="License">
  </a>
</p>

---

## Why Duraflow?

AI agents aren't simple scripts anymore. They book flights, charge payments, send emails, provision infrastructure. If your orchestration layer can't undo those actions on failure, you're building on a foundation that will eventually collapse in production.

**Duraflow gives you:**

- ✅ **Crash Recovery** — Resume from where you left off after any failure
- ✅ **Sagas** — Automatic rollback of completed steps when workflows fail
- ✅ **Rate Limiting** — Built-in token bucket for LLM APIs
- ✅ **Multi-Worker** — Concurrent task processing without duplicates

---

## Quick Start

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Install dependencies
npm install

# 3. Run the engine
npm run dev --workspace=@duraflow/engine
```

**Full documentation:** [https://duraflow-docs.vercel.app](https://duraflow-docs.vercel.app)

---

## What It Does

### Crash Recovery (Memoization)

Every step's output is automatically saved. On crash, the workflow resumes from the last successful step — no re-execution.

```typescript
const result = await ctx.step.run("process-data", async () => {
  return await api.process(input);
});
// If crash here, next run skips this step entirely
```

### Sagas (Compensation)

Define compensation functions to automatically undo completed steps on failure:

```typescript
const booking = await ctx.step.run(
  "book-flight",
  async () => {
    return await api.bookFlight(details);
  },
  {
    compensation: async (output) => {
      await api.cancelFlight(output.bookingId);
    },
  },
);
```

If payment fails later → Duraflow automatically cancels the flight.

### Multi-Worker Concurrency

PostgreSQL's `SKIP LOCKED` ensures multiple workers can process tasks concurrently without duplicate processing.

---

## Project Structure

```
duraflow/
├── apps/
│   └── engine/           # Orchestrator server (Node.js)
├── packages/
│   ├── sdk/              # Developer API (@duraflow/sdk)
│   └── proto/            # gRPC definitions
└── docs/                 # Documentation
```

---

## Usage Example

```typescript
import { workflow } from "@duraflow/sdk";

const orderWorkflow = workflow("process-order", async (ctx) => {
  // Step 1: Validate order (no compensation needed)
  const validated = await ctx.step.run("validate", async () => {
    if (!ctx.input.items.length) throw new Error("No items");
    return { valid: true };
  });

  // Step 2: Process payment (with compensation for rollback)
  const payment = await ctx.step.run(
    "charge",
    async () => {
      const result = await stripe.charge(ctx.input.amount);
      if (!result.success) throw new Error("Payment failed");
      return { transactionId: result.id };
    },
    {
      compensation: async (output) => {
        await stripe.refund(output.transactionId);
      },
    },
  );

  // Step 3: Create order
  const order = await ctx.step.run("create-order", async () => {
    return await db.orders.create({ paymentId: payment.transactionId });
  });

  return order;
});
```

---

## Tech Stack

| Component | Technology                             |
| --------- | -------------------------------------- |
| Runtime   | Node.js (10k+ concurrent waits)        |
| Queue     | PostgreSQL (SKIP LOCKED)               |
| Cache     | Redis (rate limiting, leader election) |
| Vector DB | Qdrant (agent memory)                  |
| API       | gRPC + TypeScript SDK                  |

---

## Documentation

Complete guides available at **[https://duraflow-docs.vercel.app](https://duraflow-docs.vercel.app)**:

- 📖 [Getting Started](https://duraflow-docs.vercel.app) — Quick overview
- 📦 [Installation](https://duraflow-docs.vercel.app/installation) — Setup guide
- 📚 [Tutorial](https://duraflow-docs.vercel.app/tutorial) — Build your first workflow
- 🔄 [Sagas Guide](https://duraflow-docs.vercel.app/sagas) — Compensation patterns
- 📖 [API Reference](https://duraflow-docs.vercel.app/api/overview) — SDK & gRPC docs

---

## License

[MIT](LICENSE)

---

<p align="center">
  Built with ❤️ for durable AI agent workflows
</p>
