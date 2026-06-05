import pytest

from duraflow.decorators import get_workflow, workflow


def test_bare_decorator_uses_function_name() -> None:
    @workflow
    def my_flow() -> str:
        return "ok"

    definition = get_workflow("my_flow")
    assert definition is not None
    assert definition.name == "my_flow"
    assert definition.is_async is False
    # Function stays directly callable and unchanged.
    assert my_flow() == "ok"


def test_called_decorator_no_name_uses_function_name() -> None:
    @workflow()
    def another_flow() -> None:
        return None

    assert get_workflow("another_flow") is not None


def test_explicit_name() -> None:
    @workflow("custom-name")
    def handler() -> None:
        return None

    assert get_workflow("custom-name") is not None
    assert get_workflow("handler") is None


def test_async_function_marked_async() -> None:
    @workflow("async-flow")
    async def handler() -> str:
        return "done"

    definition = get_workflow("async-flow")
    assert definition is not None
    assert definition.is_async is True


def test_docstring_preserved() -> None:
    @workflow("documented")
    def handler() -> None:
        """Important docstring."""
        return None

    assert handler.__doc__ == "Important docstring."


def test_duplicate_registration_raises() -> None:
    @workflow("once")
    def first() -> None:
        return None

    with pytest.raises(ValueError, match="already registered"):

        @workflow("once")
        def second() -> None:
            return None
