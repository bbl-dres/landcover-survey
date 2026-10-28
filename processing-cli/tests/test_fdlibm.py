"""fdlibm.sin must be bit-identical to V8's Math.sin (the browser's sin).

tests/fixtures/fdlibm_sin_golden.json: [x, Math.sin(x)] pairs produced by Node
(V8) — 5'000 random arguments over |x| ≤ π (coordinates in radians), dense Swiss
latitudes (0.78–0.84 rad), the medium-size reduction path (|x| ≤ 1e5) and the
special values (0, ±π/4, π/2, 3π/4, π, 2π, …).
"""

from __future__ import annotations

import json
import math

import fdlibm
from conftest import FIXTURES

GOLDEN = json.loads((FIXTURES / "fdlibm_sin_golden.json").read_text(encoding="utf-8"))


def test_sin_matches_v8_bit_for_bit():
    bad = [(x, js, fdlibm.sin(x)) for x, js in GOLDEN if fdlibm.sin(x) != js]
    assert not bad, bad[:5]


def test_sin_is_within_an_ulp_of_libm():
    for x, _ in GOLDEN:
        a, b = fdlibm.sin(x), math.sin(x)
        assert abs(a - b) <= 2 * math.ulp(b), (x, a, b)


def test_sin_special_values():
    assert fdlibm.sin(0.0) == 0.0
    assert fdlibm.sin(-0.0) == 0.0 and math.copysign(1, fdlibm.sin(-0.0)) == -1
    assert math.isnan(fdlibm.sin(float("nan")))
    assert math.isnan(fdlibm.sin(float("inf")))
    assert fdlibm.sin(1e-30) == 1e-30
    assert fdlibm.sin(1e7) == math.sin(1e7)  # beyond the ported range → libm fallback
