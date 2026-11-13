"""Remember inherited loader overrides before optional media imports mutate env."""
import os

# Capture only presence, never paths/values. Both setup and standalone preflight
# import this once at package entry; reconnects must reuse the same decision.
INHERITED_LOADER_OVERRIDE = any(os.environ.get(name) for name in (
    'CYCLONEDDS_URI', 'CYCLONEDDS_HOME', 'LD_LIBRARY_PATH'))
