"""Seed pre-10/25 requests without restoring approval gates in write APIs."""
import copy
from uuid import UUID

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from apps.server.fh_server import approvals
from apps.server.fh_server.models import Assignment, MapVersion, ScenarioVersion, Upload, User
from .test_maps import FEATURES, P


def database(http, database_url):
    # In-process tests use the same private DB with its migration role; wire
    # tests explicitly pass their seeded private DB URL.
    return create_engine(database_url or http.app.state.engine.url.set(username='fh_migrate'))


def pending_map(http, headers, floor, image, base=None, *, features=None, copied_from=None, database_url=None):
    actor = UUID(http.get(P + '/me', headers=headers).json()['id'])
    engine = database(http, database_url)
    try:
        with Session(engine) as db, db.begin():
            user = db.get(User, actor)
            original = db.get(MapVersion, UUID(copied_from)) if copied_from else None
            upload = db.get(Upload, UUID(image))
            metadata = upload.metadata_json
            number = (db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == UUID(floor))) or 0) + 1
            row = MapVersion(org_id=user.org_id, floor_id=UUID(floor), number=number,
                base_version_id=UUID(base) if base else None, status='PENDING',
                copied_from_id=original.id if original else None, upload_id=upload.id,
                image_path=original.image_path if original else upload.image_path,
                image_sha256=original.image_sha256 if original else upload.png_sha256,
                width=upload.width, height=upload.height, resolution=metadata['resolution'],
                origin_x=metadata['origin'][0], origin_y=metadata['origin'][1], origin_yaw=metadata['origin'][2],
                features=copy.deepcopy(original.features if original else features or FEATURES),
                reason='이전 결재 기록 시험', source='ROLLBACK' if original else 'EDIT' if base else 'IMPORT',
                created_by=user.id)
            db.add(row)
            db.flush()
            approval = approvals.request_map(db, user, row)
            version_id, approval_id = str(row.id), str(approval.id)
    finally:
        engine.dispose()
    return (http.get(P + '/map-versions/' + version_id, headers=headers).json(),
            http.get(P + '/approvals/' + approval_id, headers=headers).json())


def pending_assignment(http, headers, scenario, robot, *, database_url=None):
    actor = UUID(http.get(P + '/me', headers=headers).json()['id'])
    engine = database(http, database_url)
    try:
        with Session(engine) as db, db.begin():
            user = db.get(User, actor)
            version = db.scalar(select(ScenarioVersion).where(ScenarioVersion.scenario_id == UUID(scenario['id']),
                ScenarioVersion.number == scenario['number']))
            row = Assignment(org_id=user.org_id, scenario_version_id=version.id, robot_id=robot,
                status='PENDING', memo='배정 시험', created_by=user.id)
            db.add(row)
            db.flush()
            row.approval_id = approvals.request_assignment(db, user, row).id
            identifier = str(row.id)
    finally:
        engine.dispose()
    return next(row for row in http.get(P + '/assignments', headers=headers).json()['items'] if row['id'] == identifier)
