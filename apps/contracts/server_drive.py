"""Explicit server-drive hardware trial SI alphabet; never a phone policy."""
ALLOWED = frozenset(((0., 0., 0.), (1.5, 0., 0.), (-1.5, 0., 0.),
                     (0., 1.5, 0.), (0., -1.5, 0.), (0., 0., .5),
                     (0., 0., -.5), (1.5, 0., .5), (1.5, 0., -.5)))


def within_caps(axes, settings):
    """SI axes already constrained to ALLOWED: organization may only narrow it."""
    vx, vy, wz = axes
    return (-settings.real_max_vx_back <= vx <= settings.real_max_vx
            and abs(vy) <= settings.real_max_vy
            and abs(wz) <= settings.real_max_wz
            and not (settings.real_no_fast_server_drive and (vx or vy)))
