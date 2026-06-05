import pytest

from duraflow.registry import WorkflowRegistry


def _noop() -> None:
    return None


def test_register_and_get() -> None:
    reg = WorkflowRegistry()
    definition = reg.register("my-flow", _noop, is_async=False)
    assert definition.name == "my-flow"
    assert reg.get("my-flow") is definition
    assert reg.list() == ["my-flow"]


def test_get_unknown_returns_none() -> None:
    reg = WorkflowRegistry()
    assert reg.get("missing") is None


def test_duplicate_name_raises() -> None:
    reg = WorkflowRegistry()
    reg.register("dup", _noop, is_async=False)
    with pytest.raises(ValueError, match="already registered"):
        reg.register("dup", _noop, is_async=False)


def test_empty_name_rejected() -> None:
    reg = WorkflowRegistry()
    with pytest.raises(ValueError, match="cannot be empty"):
        reg.register("", _noop, is_async=False)


def test_too_long_name_rejected() -> None:
    reg = WorkflowRegistry()
    with pytest.raises(ValueError, match="maximum length"):
        reg.register("a" * 101, _noop, is_async=False)


@pytest.mark.parametrize("bad", ["has space", "has/slash", "emoji😀", "has.dot"])
def test_invalid_characters_rejected(bad: str) -> None:
    reg = WorkflowRegistry()
    with pytest.raises(ValueError, match="alphanumeric"):
        reg.register(bad, _noop, is_async=False)


@pytest.mark.parametrize("good", ["abc", "ABC_123", "my-flow-1", "a"])
def test_valid_names_accepted(good: str) -> None:
    reg = WorkflowRegistry()
    reg.register(good, _noop, is_async=False)
    assert reg.get(good) is not None


def test_clear_empties_registry() -> None:
    reg = WorkflowRegistry()
    reg.register("x", _noop, is_async=False)
    reg.clear()
    assert reg.list() == []
