from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import signal
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

import grpc.aio

from duraflow._generated.agent import service_pb2_grpc
from duraflow.context import StepRunner, WorkflowContext
from duraflow.decorators import get_workflow

logger = logging.getLogger("duraflow.worker")


@dataclass
class TaskAssignment:
    """A unit of work handed to the worker: which workflow to run for which task."""

    task_id: str
    workflow_name: str
    input: Any = None


# Pluggable source of work. The engine currently exposes no dequeue RPC
# (only step persistence: GetStep/CompleteStep/FailStep), so callers supply
# their own dequeue strategy until that RPC lands.
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
        if self._dequeue is None:
            logger.warning(
                "no dequeue source configured; engine exposes no dequeue RPC yet"
            )
            return []
        return await self._dequeue()

    async def _run_guarded(self, assignment: TaskAssignment) -> None:
        async with self._semaphore:
            try:
                await self.execute_task(assignment)
            except Exception:  # noqa: BLE001 — one task must not crash the worker
                logger.exception("task %s failed", assignment.task_id)

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
