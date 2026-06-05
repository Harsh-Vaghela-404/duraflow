# Duraflow Python SDK

Durable workflow engine for AI agents — crash recovery, sagas, and step memoization.

The Python SDK lets you submit and manage workflow runs on a Duraflow engine, and
define workflows whose steps are checkpointed so they survive crashes.

## Installation

```bash
pip install duraflow
```

Or with Poetry:

```bash
poetry add duraflow
```

For local development of this package:

```bash
poetry install
poetry run generate   # regenerate the gRPC stubs from the .proto files
```

## Quick Start

### Submitting and tracking tasks

`DuraflowClient` is an async client. Use it as an async context manager so the
gRPC channel is opened (with a health check) and closed for you:

```python
import asyncio
from duraflow import DuraflowClient, Status

async def main():
    async with DuraflowClient("localhost", 50051) as client:
        # Submit a workflow run — returns a handle you can poll.
        handle = await client.submit_task("my-workflow", {"user_id": 123})
        print("submitted:", handle.task_id)

        # Poll for the result.
        while True:
            status = await client.get_task(handle.task_id)
            if status.status in (Status.COMPLETED, Status.FAILED, Status.CANCELLED):
                break
            await asyncio.sleep(0.5)

        print(status.status, status.output, status.error)

        # Cancel is also available.
        # await client.cancel_task(handle.task_id)

asyncio.run(main())
```

`submit_task` returns a `TaskHandle` (`.task_id` plus `await handle.get_status()`).
`get_task` returns a `TaskStatus(task_id, status, output, error)` where `status`
is a `Status` enum value.

## Defining Workflows

Use the `@workflow` decorator. It registers your function in a process-local
registry and leaves the function unchanged (signature, docstring, and async-ness
are preserved). Three forms are supported:

```python
from duraflow import workflow, WorkflowContext

@workflow                       # name = "process_order"
async def process_order(ctx: WorkflowContext):
    ...

@workflow()                     # name = "process_order"
async def process_order(ctx: WorkflowContext):
    ...

@workflow("process-order")      # explicit name
async def process_order(ctx: WorkflowContext):
    ...
```

Workflow names must be alphanumeric with dashes/underscores, max 100 characters,
and unique within the process.

## Steps and Memoization

Inside a workflow, wrap each unit of work in `ctx.step.run(name, fn, opts)`. The
runner asks the engine whether that step already completed for this task; if so,
it returns the cached output **without re-executing** — this is what makes
workflows crash-recoverable. New steps execute, then their result (or error) is
persisted to the engine.

```python
from duraflow import workflow, WorkflowContext, StepOptions

@workflow("checkout")
async def checkout(ctx: WorkflowContext):
    # Step functions take no arguments and may be sync or async.
    order = await ctx.step.run("create-order", lambda: create_order(ctx.input))

    # Steps can be retried with exponential backoff (1s, 4s, 16s, ...).
    charge = await ctx.step.run(
        "charge-card",
        lambda: charge_card(order),
        StepOptions(retries=3),
    )

    return {"order": order, "charge": charge}
```

Each step's input/output is serialized as JSON, with a 1MB payload limit. Store
large blobs externally and pass a reference. A non-serializable value or an
oversized payload raises `SerializationError`.

## Running a Worker

`Worker` connects to the engine, executes registered workflows with a
gRPC-backed step runner, and shuts down cleanly on `SIGINT`/`SIGTERM`.

```python
import asyncio
from duraflow import Worker

async def main():
    # Import the modules that define your @workflow functions so they register.
    Worker.load_modules(["myapp.workflows"])

    worker = Worker(host="localhost", port=50051, concurrency=4)
    await worker.run()   # polls and executes until a shutdown signal arrives

asyncio.run(main())
```

You can also execute a single known assignment directly:

```python
from duraflow import Worker, TaskAssignment

worker = Worker()
await worker.start()
result = await worker.execute_task(
    TaskAssignment(task_id="abc", workflow_name="checkout", input={"cart": 1})
)
await worker.stop()
```

> The worker polls the engine via `DequeueTask` for `runtime='python'` tasks,
> heartbeats them during execution, and reports results via `CompleteTask`/`FailTask`.
> Submit Python tasks with `client.submit_task(name, input)` (defaults to
> `runtime='python'`).

## Error Handling

| Exception | When |
|---|---|
| `ConnectionError` | engine unreachable within the connect timeout |
| `RuntimeError` | client/worker used before connecting (`async with` / `start()`) |
| `ValueError` | invalid workflow name, duplicate registration, unknown workflow |
| `SerializationError` | non-serializable step payload or >1MB |

## Development

```bash
poetry run pytest          # run the test suite
poetry run mypy src/duraflow/   # strict type checking
```
