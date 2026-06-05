from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

WorkflowFn = Callable[..., Any]


@dataclass
class WorkflowDefinition:
    """A registered workflow — its name and the user function plus whether it is async."""

    name: str
    fn: WorkflowFn
    is_async: bool


class WorkflowRegistry:
    """Process-local registry mapping workflow names to their definitions.

    Mirrors the TypeScript SDK's globalRegistry: names must be unique and match
    the alphanumeric/dash/underscore pattern, max 100 chars.
    """

    _NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
    _MAX_NAME_LENGTH = 100

    def __init__(self) -> None:
        self._workflows: dict[str, WorkflowDefinition] = {}

    def register(self, name: str, fn: WorkflowFn, is_async: bool) -> WorkflowDefinition:
        self._validate_name(name)
        if name in self._workflows:
            raise ValueError(f'Workflow "{name}" is already registered.')
        definition = WorkflowDefinition(name=name, fn=fn, is_async=is_async)
        self._workflows[name] = definition
        return definition

    def get(self, name: str) -> Optional[WorkflowDefinition]:
        return self._workflows.get(name)

    def list(self) -> list[str]:
        return list(self._workflows.keys())

    def clear(self) -> None:
        """Reset the registry — primarily for test isolation."""
        self._workflows.clear()

    @classmethod
    def _validate_name(cls, name: str) -> None:
        if not name:
            raise ValueError("Workflow name cannot be empty")
        if len(name) > cls._MAX_NAME_LENGTH:
            raise ValueError(
                f"Workflow name exceeds maximum length of {cls._MAX_NAME_LENGTH} characters"
            )
        if not cls._NAME_PATTERN.match(name):
            raise ValueError(
                "Workflow name must contain only alphanumeric characters, dashes, and underscores"
            )


global_registry = WorkflowRegistry()
