from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional


class Status(str, Enum):
    UNSPECIFIED = "unspecified"
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    ROLLED_BACK = "rolled_back"
    PARTIAL_ROLLBACK = "partial_rollback"


@dataclass
class TaskStatus:
    task_id: str
    status: Status
    output: Optional[Any] = None
    error: Optional[str] = None
