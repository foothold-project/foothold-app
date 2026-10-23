"""Read-only approved connected-building registrations, shared by launch and observation."""
from sqlalchemy import select

from apps.contracts import models as C
from .models import Building, Floor, MapVersion, Upload


def approved_bindings(db, org_id):
    building = db.scalar(select(Building).where(Building.org_id == org_id,
        Building.sim_world_id == 'v5_building'))
    if building is None:
        raise ValueError('connected building is not registered')
    floors = list(db.scalars(select(Floor).where(Floor.org_id == org_id,
        Floor.building_id == building.id)))
    if len(floors) != 2 or {f.sim_floor_id for f in floors} != {'l1', 'l2'}:
        raise ValueError('both connected floors are required')
    result = []
    for f in sorted(floors, key=lambda f: f.sim_floor_id):
        v = db.scalar(select(MapVersion).where(MapVersion.org_id == org_id,
            MapVersion.id == f.approved_version_id, MapVersion.floor_id == f.id,
            MapVersion.status == 'APPROVED', MapVersion.provenance == 'SIMULATION'))
        upload = db.get(Upload, v.upload_id) if v is not None else None
        meta = upload.metadata_json if upload is not None and upload.org_id == org_id else {}
        source = meta.get('connected_gt', {})
        if (f.provenance != 'SIMULATION' or v is None or upload is None
                or upload.provenance != 'SIMULATION' or v.source != 'IMPORT'
                or source.get('world_id') != 'v5_building' or source.get('ros_floor_id') != f.sim_floor_id
                or f.floor_z != (0.0 if f.sim_floor_id == 'l1' else 2.4)
                or source.get('sha256') != v.image_sha256.hex()
                or v.image_sha256 != upload.png_sha256 or (v.width, v.height) != (upload.width, upload.height)
                or meta.get('resolution') != v.resolution
                or meta.get('origin') != [v.origin_x, v.origin_y, v.origin_yaw]):
            raise ValueError('approved connected grid registration changed')
        result.append(C.SimMapBinding(**source, building_id=building.id,
            floor_id=f.id, map_version_id=v.id, width=v.width, height=v.height,
            resolution=v.resolution, origin=(v.origin_x, v.origin_y, v.origin_yaw)))
    return result


def matches_context(context, bindings):
    """Never relabel the previous registered grid as the latest approved grid."""
    if not bindings or str(bindings[0].building_id) != context['building_id']:
        return False
    if context['map_version_id'] is None:
        return True
    return any(all(str(getattr(b, k)) == context[k] for k in
        ('floor_id', 'map_version_id', 'sha256', 'source_pgm_sha256'))
        and b.ros_floor_id == context['current_floor_id'] for b in bindings)
