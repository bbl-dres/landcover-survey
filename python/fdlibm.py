"""``sin`` exactly as JavaScript engines compute it (fdlibm port).

V8 (Chrome, Edge, Node) implements ``Math.sin`` with the fdlibm / FreeBSD msun
algorithm (``src/base/ieee754.cc``): Payne–Hanek-free argument reduction for
moderate arguments and the classic ``__kernel_sin`` / ``__kernel_cos`` polynomials.
The platform C library Python's ``math.sin`` calls (MSVC CRT, glibc, …) uses a
different algorithm; both are accurate to < 1 ulp, but they round differently on
roughly 6 % of inputs. Summed over the thousands of vertices of a polygon ring that
is enough to move a spherical area by ~1e-6 m², i.e. to flip the last exported
decimal now and then.

:func:`sin` reproduces V8 bit for bit for every argument the area formula can
produce (|x| ≤ 2^19·π/2 — coordinates in radians are far below that); larger
arguments fall back to :func:`math.sin`. Validated against Node on 200'000 random
inputs (python/tests/test_fdlibm.py keeps a golden sample).

Pure Python, ~3 µs per call — fast enough for the per-vertex use in
:mod:`geom_wgs84` (a 48 ha parcel with 560 habitat features costs ~0.3 s).
"""

from __future__ import annotations

import math
import struct

__all__ = ["sin"]

# --- bit helpers --------------------------------------------------------------

def _high_word(x: float) -> int:
    """Signed high 32 bits of the IEEE-754 double *x* (fdlibm GET_HIGH_WORD)."""
    return struct.unpack(">i", struct.pack(">d", x)[:4])[0]


def _from_words(hi: int, lo: int) -> float:
    """Double from its (unsigned) high and low 32-bit words (fdlibm INSERT_WORDS)."""
    return struct.unpack(">d", struct.pack(">II", hi & 0xFFFFFFFF, lo & 0xFFFFFFFF))[0]


# --- kernels ------------------------------------------------------------------

_S1 = -1.66666666666666324348e-01
_S2 = 8.33333333332248946124e-03
_S3 = -1.98412698298579493134e-04
_S4 = 2.75573137070700676789e-06
_S5 = -2.50507602534068634195e-08
_S6 = 1.58969099521155010221e-10

_C1 = 4.16666666666666019037e-02
_C2 = -1.38888888888741095749e-03
_C3 = 2.48015872894767294178e-05
_C4 = -2.75573143513906633035e-07
_C5 = 2.08757232129817482790e-09
_C6 = -1.13596475577881948265e-11


def _kernel_sin(x: float, y: float, iy: int) -> float:
    """sin(x + y) for |x| ≤ π/4, *y* the tail of the reduced argument (fdlibm __kernel_sin)."""
    ix = _high_word(x) & 0x7FFFFFFF
    if ix < 0x3E400000:            # |x| < 2**-27
        if int(x) == 0:
            return x
    z = x * x
    v = z * x
    r = _S2 + z * (_S3 + z * (_S4 + z * (_S5 + z * _S6)))
    if iy == 0:
        return x + v * (_S1 + z * r)
    return x - ((z * (0.5 * y - v * r) - y) - v * _S1)


def _kernel_cos(x: float, y: float) -> float:
    """cos(x + y) for |x| ≤ π/4 (fdlibm __kernel_cos)."""
    ix = _high_word(x) & 0x7FFFFFFF
    if ix < 0x3E400000:            # |x| < 2**-27
        if int(x) == 0:
            return 1.0
    z = x * x
    r = z * (_C1 + z * (_C2 + z * (_C3 + z * (_C4 + z * (_C5 + z * _C6)))))
    if ix < 0x3FD33333:            # |x| < 0.3
        return 1.0 - (0.5 * z - (z * r - x * y))
    if ix > 0x3FE90000:            # x > 0.78125
        qx = 0.28125
    else:
        qx = _from_words(ix - 0x00200000, 0)   # x / 4
    hz = 0.5 * z - qx
    a = 1.0 - qx
    return a - (hz - (z * r - x * y))


# --- argument reduction (fdlibm __ieee754_rem_pio2, moderate arguments) ---------

_INVPIO2 = 6.36619772367581382433e-01   # 2/pi
_PIO2_1 = 1.57079632673412561417e+00    # first 33 bits of pi/2
_PIO2_1T = 6.07710050650619224932e-11   # pi/2 - pio2_1
_PIO2_2 = 6.07710050630396597660e-11    # second 33 bits of pi/2
_PIO2_2T = 2.02226624879595063154e-21   # pi/2 - (pio2_1 + pio2_2)
_PIO2_3 = 2.02226624871116645580e-21    # third 33 bits of pi/2
_PIO2_3T = 8.47842766036889956997e-32   # pi/2 - (pio2_1 + pio2_2 + pio2_3)
_TWO24 = 1.67772160000000000000e+07

# High words of n·π/2 for n = 1 … 32 (fdlibm npio2_hw): the "near a multiple of
# π/2" cases that need the second / third reduction round.
_NPIO2_HW = (
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C,
    0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C,
    0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A,
    0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB,
    0x404858EB, 0x404921FB,
)


def _rem_pio2(x: float) -> tuple[int, float, float] | None:
    """Reduce *x* to y0 + y1 in [-π/4, π/4] with the quadrant n (mod 4); ``None``
    for |x| > 2^19·π/2 (the large-argument path is not ported — never reached for
    coordinates in radians)."""
    hx = _high_word(x)
    ix = hx & 0x7FFFFFFF
    if ix <= 0x3FE921FB:                     # |x| ~<= pi/4, no reduction needed
        return 0, x, 0.0
    if ix < 0x4002D97C:                      # |x| < 3pi/4, special case with n = ±1
        if hx > 0:
            z = x - _PIO2_1
            if ix != 0x3FF921FB:             # 33+53 bit pi is good enough
                y0 = z - _PIO2_1T
                y1 = (z - y0) - _PIO2_1T
            else:                            # near pi/2, use 33+33+53 bit pi
                z -= _PIO2_2
                y0 = z - _PIO2_2T
                y1 = (z - y0) - _PIO2_2T
            return 1, y0, y1
        z = x + _PIO2_1
        if ix != 0x3FF921FB:
            y0 = z + _PIO2_1T
            y1 = (z - y0) + _PIO2_1T
        else:
            z += _PIO2_2
            y0 = z + _PIO2_2T
            y1 = (z - y0) + _PIO2_2T
        return -1, y0, y1
    if ix <= 0x413921FB:                     # |x| ~<= 2^19 * (pi/2), medium size
        t = abs(x)
        n = int(t * _INVPIO2 + 0.5)
        fn = float(n)
        r = t - fn * _PIO2_1
        w = fn * _PIO2_1T                    # 1st round good to 85 bits
        if n < 32 and ix != _NPIO2_HW[n - 1]:
            y0 = r - w
        else:
            j = ix >> 20
            y0 = r - w
            i = j - ((_high_word(y0) >> 20) & 0x7FF)
            if i > 16:                       # 2nd iteration needed, good to 118 bits
                t = r
                w = fn * _PIO2_2
                r = t - w
                w = fn * _PIO2_2T - ((t - r) - w)
                y0 = r - w
                i = j - ((_high_word(y0) >> 20) & 0x7FF)
                if i > 49:                   # 3rd iteration, 151 bits accuracy
                    t = r
                    w = fn * _PIO2_3
                    r = t - w
                    w = fn * _PIO2_3T - ((t - r) - w)
                    y0 = r - w
        y1 = (r - y0) - w
        if hx < 0:
            return -n, -y0, -y1
        return n, y0, y1
    return None


def sin(x: float) -> float:
    """``Math.sin(x)`` of a JavaScript engine (fdlibm), bit for bit for |x| ≤ 2^19·π/2."""
    ix = _high_word(x) & 0x7FFFFFFF
    if ix <= 0x3FE921FB:                     # |x| ~< pi/4
        return _kernel_sin(x, 0.0, 0)
    if ix >= 0x7FF00000:                     # sin(Inf or NaN) is NaN
        return x - x
    red = _rem_pio2(x)
    if red is None:
        return math.sin(x)
    n, y0, y1 = red
    q = n & 3
    if q == 0:
        return _kernel_sin(y0, y1, 1)
    if q == 1:
        return _kernel_cos(y0, y1)
    if q == 2:
        return -_kernel_sin(y0, y1, 1)
    return -_kernel_cos(y0, y1)
