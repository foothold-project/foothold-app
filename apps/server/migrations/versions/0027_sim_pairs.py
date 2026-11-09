"""Repair simulation terrain/map pairs; archive unpaired places without deletion.

Every mutation records its previous value in events (SIM_PAIR_REPAIRED). Downgrade
keeps repaired data: use that journal and the trash restore API for selective undo.
"""
import json
import os
from pathlib import Path
from types import SimpleNamespace

from alembic import op
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from apps.contracts.models import TerrainSpec
from apps.server.fh_server.maps import refresh_connectors
from apps.server.fh_server.models import Building, Event, Floor, MapVersion, Organization, Site, Terrain, Upload, User, now
from apps.server.fh_server.resource_archive import require_unused
from apps.server.fh_server.terrains import identifier, publish_terrain_map

revision = '0027'
down_revision = '0026'
branch_labels = None
depends_on = None


class Unavailable(Exception):
    pass


def reject(status, code, message, *args):
    raise Unavailable(code)


def match_files_owner(root, created):
    """Migration may run as root; leave generated maps writable by the server."""
    try:
        owner = root.stat()
    except OSError as exc:
        print(f'SIM_PAIR_0027 ownership root={root}: {exc}')
        return
    targets = set()
    for path in created:
        targets.add(path)
        targets.update(parent for parent in path.parents if root in parent.parents)
    for path in sorted(targets, key=lambda p: (len(p.parts), str(p))):
        try:
            current = path.stat()
            if (current.st_uid, current.st_gid) != (owner.st_uid, owner.st_gid):
                os.chown(path, owner.st_uid, owner.st_gid)
        except OSError as exc:
            print(f'SIM_PAIR_0027 ownership path={path}: {exc}')


def upgrade():
    root = Path(os.environ.get('FH_FILES_ROOT', '/var/lib/foothold/files')).resolve()
    logs = []
    skipped = set()
    with Session(bind=op.get_bind()) as db:
        # Match terrain saves/trash lock order, then lock candidate floors before
        # checking usage (scenario selection also takes shared floor locks).
        list(db.scalars(select(Organization).where(or_(
            Organization.id.in_(select(Terrain.org_id)),
            Organization.id.in_(select(Site.org_id).where(Site.purpose == 'SIM'))))
            .order_by(Organization.id).with_for_update()))
        def audit(row, reason, before, after):
            data = dict(migration='0027', kind=row.__tablename__, id=str(row.id),
                org_id=str(row.org_id), reason=reason, before=before, after=after)
            db.add(Event(org_id=row.org_id, category='ACCOUNT', code='SIM_PAIR_REPAIRED',
                severity='INFO', message='시뮬 지형·지도 짝 정리', data=data))
            logs.append(data)

        def change(row, field, value, reason):
            old = getattr(row, field)
            if old == value:
                return
            def encode(v):
                return v.isoformat() if hasattr(v, 'isoformat') else str(v) if v is not None else None
            setattr(row, field, value)
            audit(row, reason, {field: encode(old)}, {field: encode(value)})

        def terrain_map(terrain, floor):
            # Terrain.map_version_id is an API projection, not a stored column.
            # Immutable upload metadata identifies the library revision's map.
            candidates = db.execute(select(MapVersion, Upload.metadata_json).join(Upload,
                (Upload.org_id == MapVersion.org_id) & (Upload.id == MapVersion.upload_id)).where(
                MapVersion.org_id == terrain.org_id, MapVersion.floor_id == floor.id,
                MapVersion.source == 'IMPORT', MapVersion.provenance == 'SIMULATION',
                MapVersion.status == 'APPROVED').order_by(MapVersion.number.desc()))
            return next((v for v, meta in candidates if meta.get('terrain_id') == terrain.id
                and meta.get('terrain_version') == terrain.version and meta.get('terrain_spec') == terrain.spec), None)

        def unused(floor):
            try:
                require_unused(db, floor.org_id, reject, floor=floor)
            except Unavailable:
                if floor.id not in skipped:
                    skipped.add(floor.id)
                    logs.append(dict(migration='0027', kind='floors', id=str(floor.id),
                        org_id=str(floor.org_id), reason='in_use_preserved'))
                return False
            return True

        # F: restore/rebuild from the authoritative terrain spec, never infer
        # terrain from map pixels. Savepoint failure archives only the terrain.
        for terrain in list(db.scalars(select(Terrain).where(Terrain.archived_at.is_(None)))):
            floor = db.scalar(select(Floor).where(Floor.org_id == terrain.org_id,
                Floor.terrain_id == terrain.id).with_for_update())
            building = db.get(Building, floor.building_id) if floor else None
            site = db.get(Site, building.site_id) if building else None
            if site and site.purpose != 'SIM':
                continue  # REAL hierarchy is outside this migration.
            if floor and building.sim_world_id and floor.provenance == 'SIMULATION':
                continue
            if floor and all(x.archived_at is None for x in (floor, building, site)) and terrain_map(terrain, floor) is not None:
                continue
            if floor and not unused(floor):
                continue
            checkpoint = len(logs)
            try:
                with db.begin_nested():
                    spec = TerrainSpec.model_validate(terrain.spec)
                    if spec.id != terrain.id:
                        raise Unavailable('INVALID_TERRAIN')
                    actor_id = db.scalar(select(User.id).where(User.org_id == terrain.org_id)
                        .order_by((User.role == 'ORG_ADMIN').desc(), User.id).limit(1))
                    if actor_id is None:
                        raise Unavailable('NO_MAP_AUTHOR')
                    if site is None:
                        site = db.get(Site, identifier(terrain.org_id, 'site'))
                        if site is None:
                            site = Site(id=identifier(terrain.org_id, 'site'), org_id=terrain.org_id,
                                name='시뮬 지형', purpose='SIM')
                            db.add(site)
                            db.flush()
                            audit(site, 'terrain_only_rebuild', {'exists': False}, {'exists': True})
                        if site.purpose != 'SIM':
                            raise Unavailable('REAL_PARENT')
                    if building is None:
                        building = db.get(Building, identifier(terrain.org_id, terrain.id + '/building'))
                        if building is None:
                            building = Building(id=identifier(terrain.org_id, terrain.id + '/building'),
                                org_id=terrain.org_id, site_id=site.id, name=spec.name)
                            db.add(building)
                            db.flush()
                            audit(building, 'terrain_only_rebuild', {'exists': False}, {'exists': True})
                        elif building.site_id != site.id:
                            raise Unavailable('PARENT_MISMATCH')
                    if floor is None:
                        floor = Floor(id=identifier(terrain.org_id, terrain.id + '/floor'),
                            org_id=terrain.org_id, building_id=building.id, terrain_id=terrain.id,
                            name='1층', level=1, provenance='SIMULATION', floor_z=0)
                        db.add(floor)
                        db.flush()
                        audit(floor, 'terrain_only_rebuild', {'exists': False}, {'exists': True})
                    for parent in (site, building, floor):
                        change(parent, 'archived_at', None, 'terrain_only_restore')
                    previous = floor.approved_version_id
                    created = []
                    published = publish_terrain_map(db, SimpleNamespace(org_id=terrain.org_id, id=actor_id),
                        spec, floor, terrain.version, root, reject, created)
                    match_files_owner(root, created)
                    audit(floor, 'terrain_only_rebuild',
                        {'approved_version_id': str(previous) if previous else None},
                        {'approved_version_id': str(published.id)})
                    db.flush()
            except (Unavailable, ValidationError, OSError, ValueError):
                del logs[checkpoint:]
                change(terrain, 'archived_at', now(), 'terrain_only_unrecoverable')
                db.flush()

        # D, then A/B/C/E/I. World identity is server-side, including Gazebo-only
        # v5 worlds; do not use a browser catalogue or image SHA allowlist.
        floors = list(db.scalars(select(Floor).join(Building, Building.id == Floor.building_id)
            .join(Site, Site.id == Building.site_id).where(Site.purpose == 'SIM', Floor.archived_at.is_(None))
            .with_for_update(of=Floor)))
        for floor in floors:
            building = db.get(Building, floor.building_id)
            if building.sim_world_id and floor.provenance == 'SIMULATION':
                continue
            terrain = db.get(Terrain, (floor.terrain_id, floor.org_id)) if floor.terrain_id else None
            version = terrain_map(terrain, floor) if terrain and terrain.archived_at is None else None
            if version is not None:
                change(floor, 'approved_version_id', version.id, 'terrain_map_revision_repair')
                db.flush()
                refresh_connectors(db, floor)
                continue
            if unused(floor):
                change(floor, 'archived_at', now(), 'map_only_no_live_pair')
                db.flush()
                refresh_connectors(db, floor)

        # Archive empty SIM containers except the shared terrain site.
        # Descendants/scenarios stay recoverable in parent-first order.
        buildings = list(db.scalars(select(Building).join(Site, Site.id == Building.site_id)
            .where(Site.purpose == 'SIM', Building.archived_at.is_(None))))
        for building in buildings:
            if db.scalar(select(Floor.id).where(Floor.building_id == building.id, Floor.archived_at.is_(None)).limit(1)) is None:
                change(building, 'archived_at', now(), 'no_live_floors')
        db.flush()
        for site in db.scalars(select(Site).where(Site.purpose == 'SIM', Site.archived_at.is_(None))):
            if site.id == identifier(site.org_id, 'site'):
                continue
            if db.scalar(select(Floor.id).join(Building, Building.id == Floor.building_id).where(
                    Building.site_id == site.id, Floor.archived_at.is_(None)).limit(1)) is None:
                change(site, 'archived_at', now(), 'no_live_floors')
        db.flush()
    for entry in logs:
        print('SIM_PAIR_0027 ' + json.dumps(entry, ensure_ascii=False, sort_keys=True))
    print(f'SIM_PAIR_0027 in_use_floors_preserved={len(skipped)}')


def downgrade():
    # An automatic reversal would resurrect map-only floors and could overwrite
    # later user restores/edits. Keep the durable before/after journal instead.
    print('SIM_PAIR_0027 downgrade retains data; selective undo: events.code=SIM_PAIR_REPAIRED, data.migration=0027; restore parents before floors in trash')
