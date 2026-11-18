#!/usr/bin/env python3
"""Reuse the ARM offline builder, including setup's QR dependency.

Plan by default. ARM Cyclone DDS must still be supplied and reviewed separately.
Run in the Git checkout, not in the installation source archive.
"""
import importlib.util
from pathlib import Path
import sys


def main(argv=None):
    directory = Path(__file__).resolve().parents[3]/'deploy/jetson'
    spec = importlib.util.spec_from_file_location('jetson_setup_wheelhouse', directory/'build_wheelhouse.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    builder.PINS = [*builder.PINS, 'qrcode==8.2']
    # The existing builder imports its sibling installer after validating all
    # wheels. Restore the search path even when plan/build fails.
    previous = list(sys.path)
    try:
        sys.path.insert(0, str(directory))
        return builder.main(argv)
    finally:
        sys.path[:] = previous


if __name__ == '__main__':
    raise SystemExit(main())
