"""Explicit server-drive hardware trial SI alphabet; never a phone policy."""
# Full-stick remote turns measured ±2.47 rad/s (peak one-second mean).
MAX_TURN_RATE = 2.5
ALLOWED = frozenset({(0., 0., 0.), (1.5, 0., 0.), (-1.5, 0., 0.),
                     (0., 1., 0.), (0., -1., 0.)}
                    | {(vx, 0., wz) for vx in (0., 1.5)
                       for wz in (-MAX_TURN_RATE, -.5, .5, MAX_TURN_RATE)})


def within_caps(axes, settings):
    """SI axes already constrained to ALLOWED: organization may only narrow it."""
    vx, vy, wz = axes
    return (-settings.real_max_vx_back <= vx <= settings.real_max_vx
            and abs(vy) <= settings.real_max_vy
            and abs(wz) <= settings.real_max_wz
            and not (settings.real_no_fast_server_drive and (vx or vy)))
