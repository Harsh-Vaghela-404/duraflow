from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import logging
import signal
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

import grpc.aio

from duraflow._generated.agent import service_pb2, service_pb2_grpc
from duraflow.context import StepRunner, WorkflowContext
from duraflow.decorators import get_workflow
from duraflow.serialization import serialize

logger = logging.getLogger("duraflow.worker")


@dataclass
class TaskAssignment:
    """A unit of work handed to the worker: which workflow to run for which task."""

    task_id: str
    workflow_name: str
    input: Any = None


# Optional override for the source of work. By default the worker polls the
# engine via the DequeueTask RPC; tests or custom setups may inject their own.
DequeueFn = Callable[[], Awaitable[list[TaskAssignment]]]


class Worker:
    """Polls for task assignments and executes registered workflows concurrently.

    Workflows are registered via the @workflow decorator; load_modules() imports
    user modules so their decorators run. execute_task() runs a single workflow
    with a gRPC-backed StepRunner for crash-recovery memoization.
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 50051,
        concurrency: int = 4,
        dequeue: Optional[DequeueFn] = None,
        poll_interval: float = 0.5,
    ) -> None:
        self._host = host
        self._port = port
        self._concurrency = concurrency
        self._dequeue = dequeue
        self._poll_interval = poll_interval
        self._channel: Optional[grpc.aio.Channel] = None  # type: ignore[type-arg,unused-ignore]
        self._stub: Optional[service_pb2_grpc.AgentServiceStub] = None
        self._semaphore = asyncio.Semaphore(concurrency)
        self._shutdown = asyncio.Event()
        self._worker_id = f"py-{uuid.uuid4().hex[:8]}"
        self._heartbeat_interval = 5.0

    @staticmethod
    def load_modules(module_names: list[str]) -> None:
        """Import the given modules so their @workflow decorators register."""
        for name in module_names:
            importlib.import_module(name)

    async def start(self) -> None:
        target = f"{self._host}:{self._port}"
        self._channel = grpc.aio.insecure_channel(target)
        self._stub = service_pb2_grpc.AgentServiceStub(self._channel)  # type: ignore[no-untyped-call]
        logger.info("worker connected to %s", target)

    async def stop(self) -> None:
        if self._channel is not None:
            await self._channel.close(None)
            self._channel = None
            self._stub = None
        logger.info("worker stopped")

    async def execute_task(self, assignment: TaskAssignment) -> Any:
        """Run one workflow end-to-end with a gRPC-backed step runner."""
        if self._stub is None:
            raise RuntimeError("Worker is not started. Call start() first.")
        definition = get_workflow(assignment.workflow_name)
        if definition is None:
            raise ValueError(
                f'Workflow "{assignment.workflow_name}" is not registered.'
            )
        runner = StepRunner(self._stub, assignment.task_id)
        ctx = WorkflowContext(
            run_id=assignment.task_id,
            workflow_name=assignment.workflow_name,
            input=assignment.input,
            step=runner,
        )
        result = definition.fn(ctx)
        if inspect.isawaitable(result):
            return await result
        return result

    async def run(self) -> None:
        """Start, then poll-and-execute until a shutdown signal is received."""
        await self.start()
        self._install_signal_handlers()
        try:
            while not self._shutdown.is_set():
                assignments = await self._poll()
                if not assignments:
                    await self._sleep_or_shutdown(self._poll_interval)
                    continue
                await asyncio.gather(
                    *(self._run_guarded(a) for a in assignments)
                )
        finally:
            await self.stop()

    def request_shutdown(self) -> None:
        """Signal the run loop to drain and exit."""
        self._shutdown.set()

    async def _poll(self) -> list[TaskAssignment]:
        if self._stub is None:
            raise RuntimeError("Worker is not started. Call start() first.")
        if self._dequeue is not None:
            return await self._dequeue()
        request = service_pb2.DequeueTaskRequest(  # type: ignore[attr-defined]
            runtime="python", batch_size=self._concurrency, worker_id=self._worker_id
        )
        response = await self._stub.DequeueTask(request)
        return [
            TaskAssignment(
                task_id=t.task_id,
                workflow_name=t.workflow_name,
                input=json.loads(t.input) if t.input else None,
            )
            for t in response.tasks
        ]

    async def execute_and_report(self, assignment: TaskAssignment) -> None:
        """Run a task with a heartbeat loop, then report Complete/Fail to the engine."""
        if self._stub is None:
            raise RuntimeError("Worker is not started. Call start() first.")
        hb = asyncio.create_task(self._heartbeat_loop(assignment.task_id))
        try:
            result = await self.execute_task(assignment)
            await self._stub.CompleteTask(
                service_pb2.CompleteTaskRequest(  # type: ignore[attr-defined]
                    task_id=assignment.task_id, output=serialize(result)
                )
            )
        except Exception as exc:  # noqa: BLE001 - report failure, never crash the worker
            logger.exception("task %s failed", assignment.task_id)
            await self._stub.FailTask(
                service_pb2.FailTaskRequest(  # type: ignore[attr-defined]
                    task_id=assignment.task_id,
                    error=serialize({"message": str(exc), "name": type(exc).__name__}),
                )
            )
        finally:
            hb.cancel()

    async def _heartbeat_loop(self, task_id: str) -> None:
        assert self._stub is not None
        try:
            while True:
                await asyncio.sleep(self._heartbeat_interval)
                await self._stub.Heartbeat(
                    service_pb2.HeartbeatRequest(  # type: ignore[attr-defined]
                        task_id=task_id, worker_id=self._worker_id
                    )
                )
        except asyncio.CancelledError:
            pass

    async def _run_guarded(self, assignment: TaskAssignment) -> None:
        async with self._semaphore:
            await self.execute_and_report(assignment)

    async def _sleep_or_shutdown(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._shutdown.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    def _install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self.request_shutdown)
            except NotImplementedError:
                # Signal handlers are unavailable on some platforms (e.g. Windows).
                pass
