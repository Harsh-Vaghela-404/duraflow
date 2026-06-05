from unittest.mock import AsyncMock

import pytest

from duraflow.client import DuraflowClient, TaskHandle
from duraflow.models import Status
from duraflow.serialization import serialize
from tests.conftest import make_response


def _client_with_stub(stub: AsyncMock) -> DuraflowClient:
    client = DuraflowClient("localhost", 50051)
    client._stub = stub  # inject without opening a real channel
    return client


async def test_submit_task_returns_handle(fake_stub: AsyncMock) -> None:
    fake_stub.SubmitTask.return_value = make_response(task_id="task-42")
    client = _client_with_stub(fake_stub)

    handle = await client.submit_task("my-flow", {"k": "v"})
    assert isinstance(handle, TaskHandle)
    assert handle.task_id == "task-42"
    fake_stub.SubmitTask.assert_awaited_once()


async def test_get_task_maps_status_and_output(fake_stub: AsyncMock) -> None:
    fake_stub.GetTaskStatus.return_value = make_response(
        status=3, output=serialize({"result": 7}), error=b""
    )
    client = _client_with_stub(fake_stub)

    status = await client.get_task("task-42")
    assert status.task_id == "task-42"
    assert status.status == Status.COMPLETED
    assert status.output == {"result": 7}
    assert status.error is None


async def test_get_task_with_error(fake_stub: AsyncMock) -> None:
    fake_stub.GetTaskStatus.return_value = make_response(
        status=4, output=b"", error=b"something failed"
    )
    client = _client_with_stub(fake_stub)

    status = await client.get_task("task-42")
    assert status.status == Status.FAILED
    assert status.error == "something failed"


async def test_cancel_task_returns_bool(fake_stub: AsyncMock) -> None:
    fake_stub.CancelTask.return_value = make_response(success=True)
    client = _client_with_stub(fake_stub)

    assert await client.cancel_task("task-42") is True


async def test_task_handle_get_status_delegates(fake_stub: AsyncMock) -> None:
    fake_stub.GetTaskStatus.return_value = make_response(
        status=2, output=b"", error=b""
    )
    client = _client_with_stub(fake_stub)
    handle = TaskHandle("task-42", client)

    status = await handle.get_status()
    assert status.status == Status.RUNNING


async def test_operations_without_connection_raise() -> None:
    client = DuraflowClient("localhost", 50051)
    with pytest.raises(RuntimeError, match="not connected"):
        await client.submit_task("flow", {})


async def test_submit_task_sends_runtime(fake_stub: AsyncMock) -> None:
    fake_stub.SubmitTask.return_value = make_response(task_id="t-1")
    client = _client_with_stub(fake_stub)
    await client.submit_task("flow", {"a": 1}, runtime="python")
    sent = fake_stub.SubmitTask.call_args.args[0]
    assert sent.runtime == "python"
