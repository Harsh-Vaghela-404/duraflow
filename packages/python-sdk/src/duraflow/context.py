from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, TypeVar, Union, cast

from duraflow._generated.agent import service_pb2
from duraflow.serialization import deserialize, serialize

T = TypeVar("T")

# A step function takes no args and returns either a value or an awaitable.
StepFn = Callable[[], Union[T, Awaitable[T]]]

# Base for exponential backoff between step retries (seconds): 1s, 4s, 16s...
_RETRY_BACKOFF_BASE = 4


@dataclass
class StepOptions:
    """Per-step configuration. Mirrors the TypeScript StepOptions subset."""

    retries: int = 0


class StepRunner:
    """Executes workflow steps with crash-recovery memoization via the engine.

    On each run(): query the engine for an existing completed step. If present,
    return its cached output without re-executing. Otherwise execute the user
    function, persist the result (CompleteStep) or error (FailStep).
    """

    def __init__(self, stub: Any, task_id: str) -> None:
        # stub: the (untyped) generated AgentServiceStub
        self._stub = stub
        self._task_id = task_id

    async def run(
        self,
        name: str,
        fn: StepFn[T],
        opts: Optional[StepOptions] = None,
    ) -> T:
        options = opts if opts is not None else StepOptions()

        cached = await self._get_cached(name)
        if cached is not None:
            found, output = cached
            return cast(T, output)

        last_error: Optional[BaseException] = None
        for attempt in range(options.retries + 1):
            try:
                result = await self._invoke(fn)
                await self._complete(name, result)
                return result
            except Exception as exc:  # noqa: BLE001 — capture to persist + maybe retry
                last_error = exc
                if attempt < options.retries:
                    await asyncio.sleep(_RETRY_BACKOFF_BASE**attempt)
                    continue
                await self._fail(name, exc)
                raise

        # Unreachable: the loop either returns or raises. Satisfies type checker.
        assert last_error is not None
        raise last_error

    async def _get_cached(self, step_key: str) -> Optional[tuple[bool, Any]]:
        request = service_pb2.GetStepRequest(task_id=self._task_id, step_key=step_key)  # type: ignore[attr-defined]
        response = await self._stub.GetStep(request)
        if response.found and response.completed:
            return True, deserialize(response.output)
        return None

    async def _invoke(self, fn: StepFn[T]) -> T:
        result = fn()
        if inspect.isawaitable(result):
            return cast(T, await result)
        return result

    async def _complete(self, step_key: str, result: Any) -> None:
        request = service_pb2.CompleteStepRequest(  # type: ignore[attr-defined]
            task_id=self._task_id, step_key=step_key, output=serialize(result)
        )
        await self._stub.CompleteStep(request)

    async def _fail(self, step_key: str, error: BaseException) -> None:
        payload = serialize(
            {"message": str(error), "name": type(error).__name__}
        )
        request = service_pb2.FailStepRequest(  # type: ignore[attr-defined]
            task_id=self._task_id, step_key=step_key, error=payload
        )
        await self._stub.FailStep(request)


@dataclass
class WorkflowContext:
    """Passed to every workflow function — provides run metadata and the step runner."""

    run_id: str
    workflow_name: str
    input: Any
    step: StepRunner = field(repr=False)
