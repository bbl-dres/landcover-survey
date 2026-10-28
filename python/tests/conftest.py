"""Shared test setup: import path + the JS evaluation of the parity cases."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
PY_DIR = HERE.parent
REPO = PY_DIR.parent
FIXTURES = HERE / "fixtures"

if str(PY_DIR) not in sys.path:
    sys.path.insert(0, str(PY_DIR))


@pytest.fixture(scope="session")
def cases() -> dict:
    return json.loads((FIXTURES / "parity_cases.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def js_dump() -> dict:
    """The web app's answers to the parity cases (tests/js_dump.mjs run with Node)."""
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not available — JS parity tests skipped")
    res = subprocess.run(
        [node, str(HERE / "js_dump.mjs"), str(FIXTURES / "parity_cases.json")],
        capture_output=True, text=True, encoding="utf-8", cwd=str(REPO),
    )
    if res.returncode != 0:
        pytest.fail(f"js_dump.mjs failed (exit {res.returncode}):\n{res.stderr}")
    return json.loads(res.stdout)
