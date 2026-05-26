import duraflow


def test_version_is_defined() -> None:
    assert duraflow.__version__ == "0.1.0"


def test_package_is_importable() -> None:
    assert duraflow is not None
