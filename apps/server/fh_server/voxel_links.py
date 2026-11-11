"""Immutable annotation snapshots on the same server-created voxel raster."""
import copy
from uuid import UUID

from sqlalchemy import func, select

from .models import Floor, MapVersion, Upload


def same_annotation_raster(version, anchor, image):
    """All #333 identity/geometry/edit conditions, shared with scenario updates."""
    origin = [version.origin_x, version.origin_y, version.origin_yaw]
    return (anchor is not None and image is not None and anchor.org_id == version.org_id and anchor.floor_id == version.floor_id
        and anchor.upload_id == version.upload_id and image.org_id == version.org_id
        and anchor.provenance == version.provenance == image.provenance
        and version.status in ('APPROVED', 'SUPERSEDED') and anchor.status in ('APPROVED', 'SUPERSEDED')
        and version.image_sha256 == anchor.image_sha256 == image.png_sha256
        and (version.width, version.height) == (anchor.width, anchor.height) == (image.width, image.height)
        and origin == [anchor.origin_x, anchor.origin_y, anchor.origin_yaw] == image.metadata_json.get('origin')
        and version.resolution == anchor.resolution == image.metadata_json.get('resolution')
        and version.features['edits'] == anchor.features['edits'])


def voxel_summary(db, version, image, *, require_twin=True):
    """Rebind the public summary only for the same floor, upload and geometry.

    Upload metadata still identifies the original SLAM snapshot. A different
    file, floor, provenance, grid or WALL/ERASE edit cannot inherit its twin.
    """
    summary = image.metadata_json.get('voxel_map')
    if not summary:
        return None
    anchor = db.get(MapVersion, UUID(summary['map_version_id']))
    origin = [version.origin_x, version.origin_y, version.origin_yaw]
    if (not same_annotation_raster(version, anchor, image)
            or anchor.provenance != 'HUMAN' or anchor.source != 'SLAM'
            or origin != summary.get('origin')):
        return summary
    if require_twin and version.id != anchor.id and db.scalar(select(Upload.id).where(
            Upload.org_id == version.org_id, Upload.provenance == 'SIMULATION',
            Upload.metadata_json['voxel_twin']['map_version_id'].astext == str(version.id)).limit(1)) is None:
        # Pre-existing annotation snapshots may not have a published twin.
        # Do not advertise a link that the fixed-plan proof cannot resolve.
        return summary
    return {**summary, 'map_version_id': str(version.id)}


def twin_proof(version, terrain_id):
    return dict(floor_id=str(version.floor_id), map_version_id=str(version.id),
        image_sha256=version.image_sha256.hex(), origin=[version.origin_x, version.origin_y, version.origin_yaw],
        resolution=version.resolution, width=version.width, height=version.height, terrain_id=terrain_id,
        terrain_size=[version.width * version.resolution, version.height * version.resolution])


def publish_annotations(db, user, version, image):
    """Publish new twins, never mutate an existing map, upload or terrain spec.

    Keep one clone per existing terrain revision so the original raster remains
    the default and an explicitly chosen raster never silently changes. Only
    metadata rows are added; their PNG/PGM bytes are shared immutable assets.
    """
    summary = voxel_summary(db, version, image, require_twin=False)
    if not summary or summary['map_version_id'] != str(version.id):
        return
    floor = db.scalar(select(Floor).where(Floor.org_id == version.org_id,
        Floor.terrain_id == summary['terrain_id'], Floor.archived_at.is_(None)).with_for_update())
    if floor is None:
        return
    templates = {}
    expected = twin_proof(version, summary['terrain_id'])
    rows = db.execute(select(MapVersion, Upload).join(Upload, Upload.id == MapVersion.upload_id).where(
        MapVersion.org_id == version.org_id, MapVersion.floor_id == floor.id,
        MapVersion.provenance == 'SIMULATION', MapVersion.source == 'IMPORT',
        MapVersion.status.in_(['APPROVED', 'SUPERSEDED']), Upload.org_id == version.org_id,
        Upload.provenance == 'SIMULATION').order_by(MapVersion.number))
    for candidate, upload in rows:
        meta = upload.metadata_json
        proof = meta.get('voxel_twin', {})
        # The only variable is the source snapshot UUID on the same immutable
        # HUMAN upload. All source geometry and provenance must still match.
        if proof != {**expected, 'map_version_id': proof.get('map_version_id')}:
            continue
        source = db.get(MapVersion, UUID(proof['map_version_id']))
        if (source is None or source.org_id != version.org_id or source.upload_id != image.id
                or source.floor_id != version.floor_id or source.provenance != 'HUMAN'
                or source.status not in ('APPROVED', 'SUPERSEDED')):
            continue
        templates.setdefault(meta['terrain_version'], (candidate, upload))
    current = db.get(MapVersion, floor.approved_version_id)
    current_upload = db.get(Upload, current.upload_id) if current else None
    current_terrain = current_upload.metadata_json.get('terrain_version') if current_upload else None
    number = db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == floor.id)) or 0
    for terrain_version, (template, upload) in sorted(templates.items()):
        metadata = copy.deepcopy(upload.metadata_json)
        metadata['voxel_twin'] = expected
        clone_image = Upload(org_id=version.org_id, provenance='SIMULATION', image_path=upload.image_path,
            image_sha256=upload.image_sha256, png_sha256=upload.png_sha256, size_bytes=upload.size_bytes,
            width=upload.width, height=upload.height, metadata_json=metadata, created_by=user.id)
        db.add(clone_image)
        db.flush()
        number += 1
        clone = MapVersion(org_id=version.org_id, floor_id=floor.id, number=number, provenance='SIMULATION',
            base_version_id=floor.approved_version_id, copied_from_id=template.id, upload_id=clone_image.id,
            status='APPROVED', source='IMPORT', image_path=template.image_path, image_sha256=template.image_sha256,
            width=template.width, height=template.height, resolution=template.resolution,
            origin_x=template.origin_x, origin_y=template.origin_y, origin_yaw=template.origin_yaw,
            features=copy.deepcopy(version.features), reason='실기 지도 구역·지점 저장과 같은 시뮬 지도', created_by=user.id)
        db.add(clone)
        db.flush()
        if terrain_version == current_terrain:
            floor.approved_version_id = clone.id
    db.flush()
