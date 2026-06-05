from unittest.mock import AsyncMock

import pytest

from duraflow.context import StepOptions, StepRunner
from duraflow.serialization import serialize
from tests.conftest import make_response


async def test_cache_hit_returns_without_executing(fake_stub: AsyncMock) -> None:
    fake_stub.GetStep.return_value = make_response(
        found=True, completed=True, output=serialize({"cached": True})
    )
    runner = StepRunner(fake_stub, task_id="task-1")
    calls = 0

    async def fn() -> dict:
        nonlocal calls
        calls += 1
        return {"fresh": True}

    result = await runner.run("step-a", fn)
    assert result == {"cached": True}
    assert calls == 0
    fake_stub.CompleteStep.assert_not_awaited()


async def test_cache_miss_executes_and_completes(fake_stub: AsyncMock) -> None:
    fake_stub.GetStep.return_value = make_response(found=False, completed=False, output=b"")
    fake_stub.CompleteStep.return_value = make_response(success=True)
    runner = StepRunner(fake_stub, task_id="task-1")

    async def fn() -> int:
        return 99

    result = await runner.run("step-a", fn)
    assert result == 99
    fake_stub.CompleteStep.assert_awaited_once()


async def test_sync_step_function_supported(fake_stub: AsyncMock) -> None:
    fake_stub.GetStep.return_value = make_response(found=False, completed=False, output=b"")
    fake_stub.CompleteStep.return_value = make_response(success=True)
    runner = StepRunner(fake_stub, task_id="task-1")

    def fn() -> str:
        return "sync-result"

    result = await runner.run("step-a", fn)
    assert result == "sync-result"


async def test_error_persisted_and_reraised(fake_stub: AsyncMock) -> None:
    fake_stub.GetStep.return_value = make_response(found=False, completed=False, output=b"")
    fake_stub.FailStep.return_value = make_response(success=True)
    runner = StepRunner(fake_stub, task_id="task-1")

    async def fn() -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await runner.run("step-a", fn)
    fake_stub.FailStep.assert_awaited_once()
    fake_stub.CompleteStep.assert_not_awaited()


async def test_retries_then_succeeds(fake_stub: AsyncMock, monkeypatch: pytest.MonkeyPatch) -> None:
    # Skip real backoff sleeps.
    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("duraflow.context.asyncio.sleep", no_sleep)
    fake_stub.GetStep.return_value = make_response(found=False, completed=False, output=b"")
    fake_stub.CompleteStep.return_value = make_response(success=True)
    runner = StepRunner(fake_stub, task_id="task-1")
    attempts = 0

    async def fn() -> str:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise ValueError("transient")
        return "recovered"

    result = await runner.run("step-a", fn, StepOptions(retries=2))
    assert result == "recovered"
    assert attempts == 3
    fake_stub.FailStep.assert_not_awaited()


async def test_retries_exhausted_fails(fake_stub: AsyncMock, monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("duraflow.context.asyncio.sleep", no_sleep)
    fake_stub.GetStep.return_value = make_response(found=False, completed=False, output=b"")
    fake_stub.FailStep.return_value = make_response(success=True)
    runner = StepRunner(fake_stub, task_id="task-1")

    async def fn() -> None:
        raise ValueError("always")

    with pytest.raises(ValueError, match="always"):
        await runner.run("step-a", fn, StepOptions(retries=2))
    fake_stub.FailStep.assert_awaited_once()
