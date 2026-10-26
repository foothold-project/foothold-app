"""Existing run-context predicate with a local, failure-only diagnostic port."""
from copy import deepcopy


class RunContext:
    def __init__(self, bridge, maps, nav):
        self.bridge, self.maps, self.nav = bridge, maps, nav
        self.failure = None

    def __call__(self, request, plan):
        extension = self.bridge.extension
        telemetry = self.bridge.inputs.telemetry
        snapshot = telemetry.snapshot()
        # Keep the original short-circuit ordering and exact decision inputs.
        grid = None
        ready = None
        matched = None
        valid = (self.maps is not None and extension is not None
                 and (ready := self.nav.actions.ready())
                 and (matched := self.maps.matches(request, plan, snapshot,
                                                   (grid := extension.grid_snapshot()))))
        self.failure = None
        if not valid:
            try:
                # Short-circuited checks below are diagnostic only. They cannot
                # change valid, refresh evidence or submit/cancel an action.
                if ready is None and self.nav is not None:
                    ready = self.nav.actions.ready()
                if self.maps is not None and extension is not None and grid is None:
                    grid = extension.grid_snapshot()
                self.failure = dict(maps_present=self.maps is not None,
                    extension_present=extension is not None, nav_ready=ready,
                    maps_match=matched, telemetry=telemetry.diagnostics(),
                    nav=extension.diagnostics() if extension is not None else None,
                    map_failures=self.maps.mismatch_diagnostics(request, plan, snapshot, grid)
                        if self.maps is not None else ['maps.absent'])
            except Exception as exc:
                self.failure = dict(diagnostics_error=type(exc).__name__)
        return valid

    def failure_diagnostics(self):
        return deepcopy(self.failure)
