from __future__ import annotations

import json
from typing import Any

# Mirror the TypeScript SDK's 1MB hard limit on serialized step payloads.
_MAX_PAYLOAD_BYTES = 1_000_000


class SerializationError(Exception):
    """Raised when a value cannot be serialized or exceeds the 1MB size limit."""


def serialize(value: Any) -> bytes:
    """Serialize a step input/output to UTF-8 JSON bytes.

    Raises SerializationError if the value is not JSON-serializable or the
    encoded payload exceeds the 1MB limit.
    """
    try:
        encoded = json.dumps(value).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise SerializationError(f"Value is not JSON-serializable: {exc}") from exc
    if len(encoded) > _MAX_PAYLOAD_BYTES:
        raise SerializationError(
            f"Serialized payload of {len(encoded)} bytes exceeds the "
            f"{_MAX_PAYLOAD_BYTES}-byte limit. Store large data externally and "
            "pass a reference instead."
        )
    return encoded


def deserialize(data: bytes) -> Any:
    """Reconstruct a value from UTF-8 JSON bytes produced by serialize()."""
    if not data:
        return None
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SerializationError(f"Could not deserialize payload: {exc}") from exc
