import types
from typing import Any
from unittest.mock import AsyncMock

import pytest

from duraflow.registry import global_registry


@pytest.fixture(autouse=True)
def clear_registry() -> None:
    """Reset the process-local workflow registry before each test."""
    global_registry.clear()


def make_response(**fields: Any) -> types.SimpleNamespace:
    """Build a fake protobuf response object from keyword fields."""
    return types.SimpleNamespace(**fields)


@pytest.fixture
def fake_stub() -> AsyncMock:
    """An AsyncMock standing in for the generated AgentServiceStub."""
    return AsyncMock()
