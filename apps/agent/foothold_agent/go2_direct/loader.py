"""Remember inherited loader overrides before optional media imports mutate env."""
import os

# Capture only presence, never paths/values. Both setup and standalone preflight
# import this once at package entry; reconnects must reuse the same decision.
LOADER_OVERRIDE_NAMES = ('CYCLONEDDS_URI', 'CYCLONEDDS_HOME', 'LD_LIBRARY_PATH')
INHERITED_LOADER_OVERRIDE = any(os.environ.get(name) for name in LOADER_OVERRIDE_NAMES)


def restart_environment():
    """Keep media-added paths from becoming inherited overrides on re-exec."""
    environment = dict(os.environ)
    # A real startup override must remain subject to review. Only a process
    # that started clean may discard overrides added by optional imports.
    if not INHERITED_LOADER_OVERRIDE:
        for name in LOADER_OVERRIDE_NAMES:
            environment.pop(name, None)
    return environment
