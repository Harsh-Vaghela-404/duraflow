# Duraflow — Critical Analysis Report

> A ground-up, evidence-based read of the entire codebase (every source file in `apps/engine`, `packages/sdk`, `packages/proto`). Written to be read **next to the code** — every claim points at `file:line`.
>
> Purpose: understand what actually exists, what's broken, what's dead weight, and where to invest — before hand-building the hard features.

---

## 0. TL;DR (read this first)

Duraflow is a genuinely SDE-2/3-level codebase in its **infrastructure** (the queue, poller, leader election, worker pool, backpressure are real and correct). But it has a **headline problem**:

> **The flagship feature — saga compensation — does not work in the running engine.** It only "works" in tests, because the tests bypass the code path that's broken. Two independent bugs each break it on their own.

That is the single most important thing to internalize: **the tests are green, the feature is broken, and no test exercises the real path.** This is the classic failure mode of AI-built code — each component is correct in isolation and tested in isolation, but the *seams between components* were never integration-tested.

Maturity, honestly rated:

| Area | Verdict |
|---|---|
| Durable queue (Postgres `FOR UPDATE SKIP LOCKED`) | ✅ Solid, real |
| Poller + backpressure + event-loop monitor | ✅ Solid |
| Piscina worker pool + IPC | ✅ Solid mechanics |
| Redis leader election (Lua check-and-renew) | ⚠️ Correct locking, **broken failover** (see B2) |
| Reaper (stale-task recovery) | ✅ SQL correct, gated by broken failover |
| **Saga / compensation** | ❌ **Broken end-to-end** (see B1) |
| Rate limiting (token bucket) | ⚠️ Works, but scope-creep + dead helpers |
| External (Python) worker path | ⚠️ Half a system — no step/saga semantics |
| Tests | ⚠️ Good unit/repo coverage, **integration seams untested** |
| Product/status docs | ❌ Stale (claims shipped features as "not started" and vice-versa) |

---

## 1. How Duraflow actually works today

There are **two completely different execution models** now living in the same engine. This is the most important architectural fact and it isn't documented anywhere.

### Model A — Internal Node runtime (the original design)
The engine runs the workflow itself, in-process:

```
SubmitTask ──> agent_tasks row (status=pending, runtime='node')
                     │
   Poller (in-process, index.ts:101) dequeues runtime='node' only  ── poller.ts:66
                     │
   runTask ──> WorkflowExecutor.execute()  ── task-runner.ts, workflow-executor.ts:58
                     │
   Piscina worker thread runs the workflow  ── step-worker.ts
                     │  (worker ⇄ main thread over MessageChannel IPC)
   step.run() ⇄ IPC ⇄ StepRepository  ── ipc-client.ts, workflow-executor.ts:159
```

### Model B — External worker (added later, for Python)
The engine is just a task broker; an **external process** does the work by calling gRPC RPCs:

```
SubmitTask (runtime='python') ──> agent_tasks row
                     │
External worker polls:  DequeueTask ── agent.service.ts:252
                        Heartbeat   ── agent.service.ts:282
                        CompleteTask/FailTask ── agent.service.ts:301,337
```

**These two models are not equivalent.** Model B has **no step memoization, no saga/compensation, no per-step retry** wired through the engine — the external worker just marks the whole task complete or failed. The `GetStep/CompleteStep/FailStep` RPCs (agent.service.ts:131-250) exist to *let* an external SDK do step recovery, but nothing coordinates rollback for a Python task. So "saga support" only ever applied to Model A — which, as B1 shows, is itself broken.

This bifurcation roughly **doubled the surface area** of the engine. Worth a hard think about whether Model B earns its complexity (see §6).

---

## 2. Critical bugs (with evidence)

### 🔴 B1 — Saga compensation is broken end-to-end (CRITICAL)

The marquee feature. Broken for **two independent reasons**, either of which alone kills it.

**Bug 1a — `compensation_fn` is never persisted in the real runtime.**
- The worker computes the compensation key and sends it over IPC:
  `step-worker.ts:96-100` → `STEP_COMPLETE` payload includes `compensationFn: compensationKey ?? null`.
- The executor's IPC handler **drops it**:
  `workflow-executor.ts:172-176` destructures only `{ stepId, output }` and calls `this.stepRepo.updateCompleted(stepId, output)` — **two args**.
- `StepRepository.updateCompleted(id, output, compensationFn?)` (`step.repository.ts:41-52`) writes `compensation_fn = $4` — but with the 3rd arg missing it writes `NULL`.
- Result: `compensation_fn` is **always NULL** in production.
- Rollback selects `WHERE compensation_fn IS NOT NULL` (`step.repository.ts:76-88`) → **finds zero steps** → task transitions straight to `rolled_back` with 0 compensations run.

**Bug 1b — the compensation registry is empty in the main thread.**
- Compensations are registered *inside the worker thread*: `step-worker.ts:91` `compensationRegistry.register(...)`.
- Rollback runs in the **main thread**: `rollback-orchestrator.ts:65` `compensationRegistry.get(fnName)`.
- Piscina workers are separate `worker_threads` → **separate module instances** → separate `compensationRegistry` singleton. The main thread never `require()`s the workflow files (`index.ts:50` only *warns* if `DURAFLOW_WORKFLOWS` is unset; only `step-worker.ts:27-38` actually loads them).
- So even if 1a were fixed, `compensationRegistry.get()` in the main thread returns `undefined` → every compensation routes to DLQ.

**Why no test caught it:**
- `saga.test.ts` calls `stepRepo.updateCompleted(id, output, "booking-saga:book-flight")` **directly with the 3rd arg** (e.g. lines 92-96) and `registerCompensation(...)` **in the test process** (lines 77-79). It exercises `RollbackOrchestrator` in isolation — never the worker→executor→repo seam where the bug lives.
- `workflow-executor.test.ts` only runs `simple-wf` and `failing-wf`; the failure case explicitly has **"no compensatable steps"** (comment at line 45).
- `e2e/grpc.test.ts` runs a compensation-free `simple-wf` and a manually-completed Python task.

→ **The exact integration path that's broken is the one path with no test.**

**The fix is small** (pass `compensationFn` through the IPC handler; make the main thread aware of compensations — e.g. persist the fact and look up by the persisted name, or load workflow modules in the main thread too). But the *lesson* is the valuable part: this is what "AI wrote it and the tests pass" hides. **Recommended first move: write a failing e2e saga test, watch it fail, then fix.** That single exercise teaches the whole worker/main-thread boundary.

---

### 🟠 B2 — Reaper leader failover doesn't actually fail over (HIGH)

Leader election exists to give the reaper high availability across a cluster. It doesn't.

- `Reaper.start()` calls `tryBecomeLeader()` **exactly once** (`reaper.ts:42-46`). If another node holds the lease, it logs `"another instance is leader, skipping"` and **returns permanently** — no retry loop.
- So if the current leader dies, the followers **never attempt election again** (they only tried at boot). The lease expires in Redis, and nobody claims it until a process restarts.
- Net effect: the "singleton reaper via leader election" provides mutual exclusion but **not** availability. The whole point of leader election (survive a leader dying) is unmet.

Fix direction: followers need to periodically retry `tryBecomeLeader()` on the reaper interval, not once at startup.

---

### 🟡 B3 — `CompleteStep` RPC also drops `compensation_fn` (MEDIUM, same family as B1)

`agent.service.ts:200` calls `this.stepRepo.updateCompleted(step.id, parsed)` — two args again. So the external/SDK crash-recovery path can't persist a compensation either. Consistent with B1; fix together.

---

## 3. Dead / unnecessary code (safe to delete)

Confirmed unused via grep across `apps/engine/src` + `packages` (excluding tests):

| Item | Location | Evidence |
|---|---|---|
| `RequestCoalescer` (whole class) | `services/request-coalescer.ts` | Only referenced by its own file + a barrel re-export (`services/index.ts:8`). Never instantiated or called anywhere. **41 LOC of dead code.** |
| `RateLimiter.waitForToken()` | `rate-limiter.ts:75-83` | Never called. The worker re-implements the same poll loop inline (`step-worker.ts:66-86`) instead of using it. Dead method. |
| `TaskRepository.findPendingTasks()` | `task.repository.ts:78-84` | Never called in src. Superseded by `dequeue`. |
| Probably-dead repo helpers | `step.repository.ts:findByTaskId/findById`, `dlq.repository.ts:findAll/countAll/incrementRetryCount` | Used by tests only or not at all — audit before deleting; some are DLQ operator-surface intended for a future dashboard. |

`RequestCoalescer` and `waitForToken` are unambiguous — delete them. The rest: confirm per-item.

---

## 4. Documentation drift (misleads you about state)

`product/status.md` is dated **2026-05-17** and is now wrong in both directions:

- Claims **Rate Limiting** is `❌ NOT STARTED` (status.md:85) — but it's **shipped**: `rate-limiter.ts`, `request-coalescer.ts`, `constants/rate-limits.ts`, wired in `index.ts:63` and integrated into `step.run` (`step-worker.ts:66`).
- Claims **Python SDK** is `❌` (status.md:78) — but `packages/python-sdk` exists and the git log shows it landed (`7fa325b`, `54eaeff`).
- Lists "Known Issues" that are **already fixed**: proto enum drift (proto now has `ROLLED_BACK`/`PARTIAL_ROLLBACK`, `agent.service.proto:12-14`), missing `started_at` (now in `init.sql:27`), cancellation not signalling the worker (now wired: `agent.service.ts:119-124` → `workflow-executor.ts:130` → AbortController → rollback).

Meanwhile `knowledge-base/ARCHITECTURE.md` predates the rate-limiter and the external-worker RPCs — it doesn't mention them at all.

**Takeaway:** treat `product/*.md` and `knowledge-base/*.md` as **historical**, not current. The code is the only source of truth. (Refreshing these docs yourself is, incidentally, a great way to learn the system — see §7.)

---

## 5. Smaller findings & code-quality notes

- **`RequestCoalescer` TTL via `setTimeout` (100ms)** — even if it were used, dedupe windows via wall-clock timers are fragile. Moot while it's dead.
- **`CompensationRegistry.register`** has a pointless `if/else` that does the same thing in both branches (`compensation.ts:11-17`). Cosmetic.
- **Reaper stale threshold defaults to 30s** (`index.ts:22`, `constants/engine.ts:10`) while several docs/CLAUDE.md say 300s. Heartbeat is 5s, so 30s is fine — but the drift between constants, env defaults, and docs is a smell.
- **`getTaskStatus` returns status as `toUpperCase()` string** (`agent.service.ts:84`). Works only because proto-loader is configured with `enums: String` (`server.ts:32`). Fragile coupling; fine for now.
- **Error shapes are inconsistent** — sometimes `{message,name,stack}`, sometimes `{message}`, sometimes raw objects (`dlq.repository.ts:18-23` tries to normalize all three). Not wrong, just entropy.
- **No index supports rollback ordering** — `findCompletedWithCompensation` orders by `completed_at DESC` but the only step index is on `task_id` (`init.sql:84`). Fine at small scale; note it.

---

## 6. Architectural tensions (the interesting judgment calls)

1. **Two execution models (Node in-process vs. external Python worker).** Model B added a lot of surface (4 RPCs, a `runtime` column, dual dequeue paths) but delivers a strictly weaker feature set (no sagas/steps). Decision to make: either (a) make Model B a first-class citizen with real step/saga semantics over the `GetStep/CompleteStep/FailStep` RPCs, or (b) treat it as experimental and stop investing until Model A is correct. Right now it's half-built and dilutes focus.

2. **Rate limiting scope creep.** A token-bucket rate limiter for *LLM APIs* (OpenAI/Anthropic presets, `rate-limits.ts`) is an AI-product feature bolted onto a general durable-execution engine. It's well-built, but it's the kind of thing that makes the engine "an AI tool" rather than "a durable execution engine." Given your goal (a foundational systems project + interview signal), the **durable-execution core is the asset**; the LLM rate limiter is a distraction from the parts that impress systems interviewers.

3. **Compensation-by-thread-local-registry** (B1b) is an architectural mismatch: durable state (which step needs which compensation) is being kept in **process memory in the wrong process**. The correct model is that everything needed to roll back must be **reconstructable from Postgres** — this is exactly the "durable execution / event-sourced state" principle you wanted to learn. B1 is a live, real example of why that principle exists.

---

## 7. How to get the best out of Duraflow

Priority order, optimized for *learning* + *a defensible, correct system to talk about in interviews*:

**Phase 0 — Understand (1–2 days, by hand, no AI writing code).** See §8 for the reading path.

**Phase 1 — Make the flagship feature actually work.**
1. Write a **failing e2e saga test** that submits a saga workflow, forces a failure, and asserts compensations ran. Watch it fail. (This is the test that should have existed.)
2. Fix **B1a** (pass `compensationFn` through `workflow-executor.ts:172`).
3. Fix **B1b** (make the main thread able to resolve compensations — the clean fix teaches you the durable-state principle).
4. Fix **B2** (reaper failover retry loop) and **B3** (CompleteStep).
   → After this, you have a *correct* engine, and you'll deeply understand the worker/main-thread boundary.

**Phase 2 — Cut the fat.** Delete `RequestCoalescer` and `waitForToken`. Decide the fate of Model B (external worker) and the LLM rate limiter — keep, promote, or park. A smaller, correct, coherent system beats a big half-built one in an interview.

**Phase 3 — Build the hard, résumé-defining features by hand** (the ones from our earlier discussion): durable timers → deterministic replay → signals. B1b is your on-ramp: it's literally a small version of "reconstruct execution state from the log."

**Phase 4 — Refresh the docs** (`status.md`, `ARCHITECTURE.md`) to match reality. Doing this yourself forces a full-system read and gives you the "explain Duraflow" narrative you wanted.

---

## 8. Suggested reading path (for the 1–2 day deep dive)

Read in this order — each builds on the last. Trace the code live; don't just read the summary above.

1. **The data model** — `db/init.sql`, `db/task.entity.ts`, `db/step_runs.entity.ts`. Everything else is machinery around these three tables.
2. **The queue primitive** — `task.repository.ts:86` (`dequeue`, `FOR UPDATE SKIP LOCKED`). Understand *why* the CTE + `SKIP LOCKED` makes concurrent workers safe. This is the crown jewel of the infra.
3. **The poll loop** — `poller.ts` (backoff, backpressure) + `event-loop-monitor.ts` + the `checkBackpressure` closure in `index.ts:83`.
4. **Task execution (Model A)** — `task-runner.ts` → `workflow-executor.ts:58` → `step-worker.ts`. **This is where B1 lives.** Trace one `step.run()` call across the IPC boundary end to end.
5. **Saga rollback** — `rollback-orchestrator.ts` + `step.repository.ts:findCompletedWithCompensation`. Now connect it back to step 4 and *see* B1 for yourself.
6. **Recovery machinery** — `heartbeat.service.ts`, `reaper.ts`, `leader-elector.ts`. Find B2 on your own.
7. **The gRPC surface** — `grpc/server.ts` (wiring) + `agent.service.ts` (all 12 RPCs). Note the two dequeue paths (Model A poller vs. Model B `DequeueTask`).
8. **The SDK boundary** — `packages/sdk/src/*`. Small and clean; it's the public contract.

**Exercise to prove understanding:** for a single saga task, draw the sequence diagram from `SubmitTask` to `rolled_back`, labeling which **thread/process** each step runs in (gRPC main thread, poller, Piscina worker, DB). If you can draw that, you understand the whole engine — and B1 becomes obvious on the diagram.

---

*Generated from a full source read on 2026-07-04. Every `file:line` reference was current at that commit (`d6cd020`).*
