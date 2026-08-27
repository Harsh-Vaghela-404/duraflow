from __future__ import annotations

import inspect
from typing import Callable, Optional, TypeVar, Union, overload

from duraflow.registry import WorkflowDefinition, WorkflowFn, global_registry

F = TypeVar("F", bound=WorkflowFn)


@overload
def workflow(name_or_fn: F) -> F:
    ...


@overload
def workflow(name_or_fn: Optional[str] = None) -> Callable[[F], F]:
    ...


def workflow(name_or_fn: Union[str, F, None] = None) -> Union[F, Callable[[F], F]]:
    """Register a function as a Duraflow workflow.

    Supports three forms:

        @workflow
        async def my_flow(ctx): ...        # name = "my_flow"

        @workflow()
        async def my_flow(ctx): ...        # name = "my_flow"

        @workflow("custom-name")
        async def my_flow(ctx): ...        # name = "custom-name"

    The function is returned unchanged (signature, docstring, async-ness, and
    type hints all preserved), so it stays directly callable.
    """

    def decorate(fn: F, name: Optional[str]) -> F:
        resolved_name = name if name is not None else fn.__name__
        is_async = inspect.iscoroutinefunction(fn)
        global_registry.register(resolved_name, fn, is_async)
        return fn

    # Bare @workflow (decorator applied directly to the function)
    if callable(name_or_fn):
        return decorate(name_or_fn, None)

    # @workflow() or @workflow("name") - return the actual decorator
    name = name_or_fn

    def decorator(fn: F) -> F:
        return decorate(fn, name)

    return decorator


def get_workflow(name: str) -> Optional[WorkflowDefinition]:
    """Look up a registered workflow definition by name."""
    return global_registry.get(name)
