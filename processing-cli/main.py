"""Landcover Survey — entry point.

    python main.py --help

The code lives in ``src/`` (the CLI itself in ``src/cli.py``); input lists go to
``in/`` and results are written to ``out/`` (both gitignored).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from cli import main  # noqa: E402

if __name__ == "__main__":
    main()
