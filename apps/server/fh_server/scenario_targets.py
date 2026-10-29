"""Shared target boundary for assignment and future server execution prechecks."""
from sqlalchemy import select
from apps.contracts.models import SIM_MAP_REQUIRES_SIM_ROBOT
from .models import MapVersion
from .resource_archive import require_live_floors


def simulation_only(db, version):
    return db.scalar(select(MapVersion.id).where(
        MapVersion.org_id == version.org_id, MapVersion.id.in_(version.map_version_ids),
        MapVersion.provenance == 'SIMULATION').limit(1)) is not None


def require_target(db, version, robot, fail):
    require_live_floors(db, version, fail)
    if not robot.simulation and simulation_only(db, version):
        fail(422, SIM_MAP_REQUIRES_SIM_ROBOT, '시뮬 지도 시나리오는 시뮬 로봇에만 배정하거나 실행할 수 있습니다.')
