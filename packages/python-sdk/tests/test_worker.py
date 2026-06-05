import asyncio
from unittest.mock import AsyncMock

import pytest

from duraflow.context import WorkflowContext
from duraflow.decorators import workflow
from duraflow.worker import TaskAssignment, Worker
from tests.conftest import make_response


def _worker_with_stub(stub: AsyncMock) -> Worker:
    worker = Worker()
    worker._stub = stub
    return worker


async def test_execute_task_runs_registered_workflow(fake_stub: AsyncMock) -> None:
    fake_stub.GetStep.return_value = make_response(found=False, completed=False, output=b"")
    fake_stub.CompleteStep.return_value = make_response(success=True)

    @workflow("greet")
    async def greet(ctx: WorkflowContext) -> str:
        return await ctx.step.run("say", lambda: f"hello {ctx.input}")

    worker = _worker_with_stub(fake_stub)
    result = await worker.execute_task(
        TaskAssignment(task_id="t1", workflow_name="greet", input="world")
    )
    assert result == "hello world"


async def test_execute_unregistered_workflow_raises(fake_stub: AsyncMock) -> None:
    worker = _worker_with_stub(fake_stub)
    with pytest.raises(ValueError, match="not registered"):
        await worker.execute_task(
            TaskAssignment(task_id="t1", workflow_name="missing", input=None)
        )


async def test_execute_without_start_raises() -> None:
    @workflow("noop")
    async def noop(ctx: WorkflowContext) -> None:
        return None

    worker = Worker()  # never started, no stub
    with pytest.raises(RuntimeError, match="not started"):
        await worker.execute_task(
            TaskAssignment(task_id="t1", workflow_name="noop", input=None)
        )


async def test_run_loop_drains_dequeue_then_shuts_down(fake_stub: AsyncMock) -> None:
    fake_stub.GetStep.return_value = make_response(found=False, completed=False, output=b"")
    fake_stub.CompleteStep.return_value = make_response(success=True)
    executed: list[str] = []

    @workflow("collect")
    async def collect(ctx: WorkflowContext) -> None:
        executed.append(ctx.input)
        return None

    pending = [
        TaskAssignment(task_id="a", workflow_name="collect", input="a"),
        TaskAssignment(task_id="b", workflow_name="collect", input="b"),
    ]

    async def dequeue() -> list[TaskAssignment]:
        if pending:
            return [pending.pop(0)]
        return []

    worker = Worker(dequeue=dequeue, poll_interval=0.01)
    worker._stub = fake_stub  # avoid opening a real channel

    async def fake_start() -> None:
        return None

    worker.start = fake_start  # type: ignore[method-assign]

    async def stopper() -> None:
        await asyncio.sleep(0.1)
        worker.request_shutdown()

    await asyncio.gather(worker.run(), stopper())
    assert set(executed) == {"a", "b"}


async def test_failing_task_does_not_crash_worker(fake_stub: AsyncMock) -> None:
    fake_stub.GetStep.return_value = make_response(found=False, completed=False, output=b"")
    fake_stub.FailStep.return_value = make_response(success=True)

    @workflow("boom")
    async def boom(ctx: WorkflowContext) -> None:
        raise RuntimeError("kaboom")

    worker = _worker_with_stub(fake_stub)
    # _run_guarded swallows the exception (logs it) so the loop survives.
    await worker._run_guarded(
        TaskAssignment(task_id="t1", workflow_name="boom", input=None)
    )
