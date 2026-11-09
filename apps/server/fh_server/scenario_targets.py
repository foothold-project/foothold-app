"""Shared target boundary for assignment and future server execution prechecks."""
from sqlalchemy import select
from apps.contracts.models import SIM_MAP_REQUIRES_SIM_ROBOT, SIM_SCENARIO_NO_ASSIGN
from .models import Building, Floor, MapVersion, Site
from .resource_archive import require_live_floors


def site_purposes(db, org_id, floor_ids):
    """Purpose follows the place, independently of map content provenance."""
    return set(db.scalars(select(Site.purpose).join(Building,
        (Building.org_id == Site.org_id) & (Building.site_id == Site.id)).join(Floor,
        (Floor.org_id == Building.org_id) & (Floor.building_id == Building.id)).where(
            Site.org_id == org_id, Floor.id.in_(floor_ids)).distinct()))


def require_assignable(db, version, fail):
    if 'SIM' in site_purposes(db, version.org_id, version.floor_ids):
        fail(409, SIM_SCENARIO_NO_ASSIGN, '시뮬 시나리오는 시뮬 탭에서 바로 실행합니다')


def simulation_only(db, version):
    return db.scalar(select(MapVersion.id).where(
        MapVersion.org_id == version.org_id, MapVersion.id.in_(version.map_version_ids),
        MapVersion.provenance == 'SIMULATION').limit(1)) is not None


def require_target(db, version, robot, fail):
    require_live_floors(db, version, fail)
    if not robot.simulation and simulation_only(db, version):
        fail(422, SIM_MAP_REQUIRES_SIM_ROBOT, '시뮬 지도 시나리오는 시뮬 로봇에만 배정하거나 실행할 수 있습니다.')
