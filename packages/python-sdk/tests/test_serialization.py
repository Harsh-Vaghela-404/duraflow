import pytest

from duraflow.serialization import SerializationError, deserialize, serialize


@pytest.mark.parametrize(
    "value",
    [
        None,
        42,
        "hello",
        3.14,
        True,
        [1, 2, 3],
        {"a": 1, "b": [2, 3], "c": {"nested": True}},
    ],
)
def test_roundtrip(value: object) -> None:
    assert deserialize(serialize(value)) == value


def test_empty_bytes_deserializes_to_none() -> None:
    assert deserialize(b"") is None


def test_non_serializable_raises() -> None:
    with pytest.raises(SerializationError, match="not JSON-serializable"):
        serialize({1, 2, 3})  # sets are not JSON-serializable


def test_oversized_payload_raises() -> None:
    big = "x" * 1_000_001
    with pytest.raises(SerializationError, match="exceeds"):
        serialize(big)


def test_just_under_limit_ok() -> None:
    # "x" * N -> N + 2 bytes (surrounding quotes). Stay under 1_000_000.
    payload = "x" * 999_990
    assert deserialize(serialize(payload)) == payload


def test_corrupt_bytes_raises() -> None:
    with pytest.raises(SerializationError, match="deserialize"):
        deserialize(b"not valid json {{{")
