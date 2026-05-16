# Duraflow — Product Docs

> The product story behind Duraflow: what we're building, why, where we are, where we're going.

This folder is the **public** version of our product thinking. It is meant to be readable cold — by a potential user, a contributor, a press writer, or someone evaluating Duraflow for production use — without needing the codebase open.

For developer documentation (how to install and use Duraflow), see [`docs/`](../docs/) (published at [duraflow-docs.vercel.app](https://duraflow-docs.vercel.app)).

For code-level reference, see [`knowledge-base/`](../knowledge-base/).

## What's In Here

| File | What it's for | Who it's for |
|------|---------------|--------------|
| [overview.md](overview.md) | 1-page elevator pitch — the problem, the solution, the headline features | Anyone hearing about Duraflow for the first time |
| [vision.md](vision.md) | Long-form vision: the why, the market context, the principles | Anyone evaluating Duraflow strategically |
| [status.md](status.md) | Honest state of the build — what ships today, what doesn't | Developers evaluating Duraflow, contributors, anyone who wants ground truth |
| [roadmap.md](roadmap.md) | Phased delivery plan: now → next → later | Anyone planning around Duraflow's trajectory |

## How to Read This Folder

- **Just looking?** Read [overview.md](overview.md). Done in 5 minutes.
- **Evaluating Duraflow for a real project?** Read [overview.md](overview.md) → [status.md](status.md) → [roadmap.md](roadmap.md). Be honest with yourself about what we have today vs what's planned.
- **Want the deep story?** Start with [vision.md](vision.md), then walk through [status.md](status.md) and [roadmap.md](roadmap.md).
- **Writing about Duraflow?** Read [overview.md](overview.md) + [vision.md](vision.md). Quote freely.

## One-Line Summary

**Duraflow is a durable workflow engine that makes AI agents crash-proof — built around a simple `step.run()` API, backed by PostgreSQL, with first-class support for saga rollbacks.**
