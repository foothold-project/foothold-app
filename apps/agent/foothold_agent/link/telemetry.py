"""Local measured cache projection; never writes Core feedback or authority."""

from copy import deepcopy
import math
from uuid import UUID

STALE_S = 1.0


def number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def fresh(observation, now):
    return (isinstance(observation, dict) and observation.get("clock") == "simulation"
            and number(observation.get("received_monotonic_s"))
            and number(observation.get("progress_monotonic_s"))
            and 0 <= now - observation["received_monotonic_s"] <= STALE_S
            and 0 <= now - observation["progress_monotonic_s"] <= STALE_S)


def project(snapshot, now):
    pose = dict.fromkeys(("floor_id", "map_version_id", "x", "y", "yaw", "confidence"))
    result = {"speed": None, "pose": pose, "battery": {"soc": None}}
    if not isinstance(snapshot, dict) or not fresh(snapshot.get("observation"), now):
        return result
    context = snapshot.get('floor_context')
    if isinstance(context, dict):
        # Produced by the launch-bound bridge; deepcopy prevents later callbacks
        # from relabeling an already emitted frame, including transit frames.
        pose['floor_context'] = deepcopy(context)
    speed = snapshot.get("speed")
    if number(speed) and speed >= 0:
        result["speed"] = speed
    location = snapshot.get("location")
    if isinstance(location, dict) and fresh(location, now):
        try:
            UUID(location.get("floor_id"))
            valid_floor = True
        except (ValueError, TypeError, AttributeError):
            valid_floor = False
        if valid_floor and all(number(location.get(k)) for k in ("x", "y", "yaw")):
            pose.update({k: location[k] for k in ("floor_id", "x", "y", "yaw")})
            try:
                pose['map_version_id'] = str(UUID(location.get('map_version_id')))
            except (ValueError, TypeError, AttributeError):
                pass
            confidence = location.get("confidence")
            if number(confidence) and 0 <= confidence <= 1:
                pose["confidence"] = confidence
    battery = snapshot.get("battery")
    if isinstance(battery, dict) and number(battery.get("soc")) and 0 <= battery["soc"] <= 100:
        result["battery"]["soc"] = battery["soc"]
        if number(battery.get("voltage")) and battery["voltage"] >= 0:
            result["battery"]["voltage"] = battery["voltage"]
    return deepcopy(result)
