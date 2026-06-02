from __future__ import annotations

import asyncio
import json
import types
from typing import Any, Optional, Type

import grpc
import grpc.aio

from duraflow._generated.agent import service_pb2, service_pb2_grpc
from duraflow.models import Status, TaskStatus

_STATUS_MAP: dict[int, Status] = {
    0: Status.UNSPECIFIED,
    1: Status.PENDING,
    2: Status.RUNNING,
    3: Status.COMPLETED,
    4: Status.FAILED,
    5: Status.CANCELLED,
    6: Status.ROLLED_BACK,
    7: Status.PARTIAL_ROLLBACK,
}

_CONNECT_TIMEOUT_SECONDS = 5.0


class TaskHandle:
    """Returned by submit_task — holds the task ID and a reference back to the client for polling."""

    def __init__(self, task_id: str, client: DuraflowClient) -> None:
        self.task_id = task_id
        self._client = client

    async def get_status(self) -> TaskStatus:
        return await self._client.get_task(self.task_id)


class DuraflowClient:
    """Async gRPC client for the Duraflow engine.

    Usage:
        async with DuraflowClient("localhost", 50051) as client:
            handle = await client.submit_task("my-workflow", {"key": "value"})
            status = await handle.get_status()
    """

    def __init__(self, host: str = "localhost", port: int = 50051) -> None:
        self._host = host
        self._port = port
        self._channel: Optional[grpc.aio.Channel] = None  # type: ignore[type-arg,unused-ignore]
        self._stub: Optional[service_pb2_grpc.AgentServiceStub] = None

    async def __aenter__(self) -> DuraflowClient:
        target = f"{self._host}:{self._port}"
        self._channel = grpc.aio.insecure_channel(target)
        self._stub = service_pb2_grpc.AgentServiceStub(self._channel)  # type: ignore[no-untyped-call]
        try:
            await asyncio.wait_for(
                self._channel.channel_ready(),
                timeout=_CONNECT_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError as exc:
            await self._channel.close(None)
            self._channel = None
            self._stub = None
            raise ConnectionError(
                f"Could not connect to Duraflow engine at {target} within {_CONNECT_TIMEOUT_SECONDS}s"
            ) from exc
        return self

    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[types.TracebackType],
    ) -> None:
        if self._channel is not None:
            await self._channel.close(None)
            self._channel = None
            self._stub = None

    async def submit_task(
        self, workflow_name: str, input: Optional[Any] = None
    ) -> TaskHandle:
        stub = self._require_stub()
        payload = json.dumps(input if input is not None else {}).encode()
        request = service_pb2.SubmitTaskRequest(  # type: ignore[attr-defined]
            workflow_name=workflow_name, input=payload
        )
        response = await stub.SubmitTask(request)
        return TaskHandle(task_id=response.task_id, client=self)

    async def get_task(self, task_id: str) -> TaskStatus:
        stub = self._require_stub()
        request = service_pb2.GetTaskStatusRequest(task_id=task_id)  # type: ignore[attr-defined]
        response = await stub.GetTaskStatus(request)
        output: Optional[Any] = None
        error: Optional[str] = None
        if response.output:
            output = json.loads(response.output)
        if response.error:
            error = response.error.decode()
        return TaskStatus(
            task_id=task_id,
            status=_STATUS_MAP.get(response.status, Status.UNSPECIFIED),
            output=output,
            error=error,
        )

    async def cancel_task(self, task_id: str) -> bool:
        stub = self._require_stub()
        request = service_pb2.CancelTaskRequest(task_id=task_id)  # type: ignore[attr-defined]
        response = await stub.CancelTask(request)
        return bool(response.success)

    def _require_stub(self) -> service_pb2_grpc.AgentServiceStub:
        if self._stub is None:
            raise RuntimeError(
                "DuraflowClient is not connected. "
                "Use 'async with DuraflowClient(...) as client:'"
            )
        return self._stub
