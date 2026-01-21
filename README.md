# duraflow

Durable execution engine for AI agents. Crash-proof workflows with automatic rollbacks.

## quick start

```bash
# start infra
docker compose up -d

# install deps
npm install

# run engine
npm run dev --workspace=@duraflow/engine
```

## what it does

- **checkpointing**: every step is persisted, survives crashes
- **sagas**: define compensation logic, auto-rollback on failure  
- **rate limiting**: built-in token bucket for llm apis
- **memory**: vector storage for agent context

## project structure

```
apps/
  engine/           # orchestrator server (node.js)
  dashboard/        # debug ui (react)
packages/
  sdk/              # developer api (@duraflow/sdk)
  proto/            # grpc definitions
```

## usage

```typescript
import { workflow } from '@duraflow/sdk';

const agent = workflow('research-agent', async ({ step, input }) => {
  const data = await step.run('fetch', async () => {
    return fetch(input.url).then(r => r.json());
  });
  
  const summary = await step.run('summarize', async () => {
    return llm.complete(`summarize: ${JSON.stringify(data)}`);
  }, {
    compensation: async () => {
      // cleanup if later steps fail
    }
  });
  
  return summary;
});
```

## stack

- node.js (event loop for 10k+ concurrent waits)
- postgres (skip locked queue)
- redis (rate limiting, streams)
- qdrant (vector memory)

## license

MIT
