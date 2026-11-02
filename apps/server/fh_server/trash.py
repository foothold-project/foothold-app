"""Trash API, history labels and a durable file-deletion outbox."""
import logging
from pathlib import Path
from uuid import UUID

from sqlalchemy import any_, or_, select, text
from sqlalchemy.dialects.postgresql import distinct_on
from apps.contracts import models as C
from .models import (Approval, Assignment, Building, Event, FileDeletion, Floor, MapVersion,
                     Robot, Run, Scenario, ScenarioVersion, Site, User)
from .resource_archive import require_unused

log = logging.getLogger(__name__)
MODELS = {'site': Site, 'building': Building, 'floor': Floor, 'scenario': Scenario}
ARCHIVE_CODES = {'site': 'SITE_DELETED', 'building': 'BUILDING_DELETED',
                 'floor': 'FLOOR_DELETED', 'scenario': 'SCENARIO_ARCHIVED'}


def delete_files(factory, root, org_id):
    """Only committed outbox entries; serialize retries, retain any failed unlink.

    Paths are storage-generated relative paths. Never follow a symlink outside
    the configured root, and never delete a file still referenced by a live row.
    """
    root = Path(root).resolve()
    with factory.begin() as db:
        rows = list(db.scalars(select(FileDeletion).where(FileDeletion.org_id == org_id)
            .order_by(FileDeletion.attempts, FileDeletion.created_at, FileDeletion.id).limit(100).with_for_update(skip_locked=True)))
        for row in rows:
            try:
                path = (root / row.path).resolve()
                if not path.is_relative_to(root) or path == root:
                    raise ValueError('invalid storage path')
                source = row.path[:-5] + '.png' if row.path.endswith('.yaml') else row.path
                if db.scalar(select(MapVersion.id).where(MapVersion.image_path == source).limit(1)):
                    # The final owner's purge enqueues this path again.
                    db.delete(row)
                    continue
                from .models import Upload
                if db.scalar(select(Upload.id).where(Upload.image_path == source).limit(1)):
                    db.delete(row)
                    continue
                path.unlink(missing_ok=True)
                db.delete(row)
            except (OSError, ValueError):
                row.attempts += 1
                # No raw filesystem paths or exception text in production logs.
                log.warning('Map file deletion deferred: entry=%s attempt=%s', row.id, row.attempts)


def install(app, DB, Identity, fail, authorize, event):
    def own(db, user, kind, identifier):
        model = MODELS[kind]
        row = db.scalar(select(model).where(model.org_id == user.org_id, model.id == identifier).with_for_update())
        if row is None:
            fail(404, 'NOT_FOUND', '휴지통 항목을 찾을 수 없습니다.')
        return row

    @app.get('/api/v1/trash', response_model=C.TrashList)
    def listing(auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'O')
        archived = [(kind, row) for kind, model in MODELS.items() for row in db.scalars(
            select(model).where(model.org_id == user.org_id, model.archived_at.is_not(None)))]
        if not archived:
            return C.TrashList(items=[])
        sites = dict(db.execute(select(Site.id, Site.name).where(Site.org_id == user.org_id,
            Site.id.in_([row.site_id for kind, row in archived if kind == 'building']))).all())
        buildings = dict(db.execute(select(Building.id, Building.name).where(Building.org_id == user.org_id,
            Building.id.in_([row.building_id for kind, row in archived if kind == 'floor']))).all())
        # The archive event is the source of actor identity for old and new rows.
        # Fetch only the latest event for each current trash item, rather than
        # materializing the organization's entire archive/restore history.
        resource_id = Event.data['id'].astext
        actors = {}
        for code, identifier, actor, display in db.execute(select(Event.code, resource_id,
                Event.user_id, User.display_name).ext(distinct_on(Event.code, resource_id)).outerjoin(User,
                (Event.user_id == User.id) & (Event.org_id == User.org_id)).where(
                Event.org_id == user.org_id, or_(*((Event.code == ARCHIVE_CODES[kind]) &
                    resource_id.in_([str(row.id) for k, row in archived if k == kind])
                    for kind in MODELS))).order_by(Event.code, resource_id, Event.at.desc(), Event.id.desc())):
            actors[(code, identifier)] = C.Person(id=actor, display_name=display) if actor and display else None
        items = []
        for kind, row in archived:
            parent = sites.get(row.site_id) if kind == 'building' else buildings.get(row.building_id) if kind == 'floor' else None
            items.append(C.TrashItem(kind=kind, id=row.id, name=row.name, archived_at=row.archived_at,
                deleted_by=actors.get((ARCHIVE_CODES[kind], str(row.id))), parent_name=parent))
        return C.TrashList(items=sorted(items, key=lambda i: (i.archived_at, i.kind, str(i.id)), reverse=True))

    @app.post('/api/v1/trash/{kind}/{identifier}/restore', status_code=204)
    def restore(kind: C.TrashKind, identifier: UUID, auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'O')
        row = own(db, user, kind, identifier)
        if row.archived_at is None:
            return
        if kind in ('floor', 'building'):
            parent_model, parent_id = (Building, row.building_id) if kind == 'floor' else (Site, row.site_id)
            parent = db.scalar(select(parent_model).where(parent_model.org_id == user.org_id,
                parent_model.id == parent_id).with_for_update(read=True))
            if parent.archived_at is not None:
                fail(409, 'PARENT_ARCHIVED', '상위 건물을 먼저 되살리세요.' if kind == 'floor' else '상위 장소를 먼저 되살리세요.')
            if kind == 'floor':
                site = db.scalar(select(Site).where(Site.org_id == user.org_id, Site.id == parent.site_id).with_for_update(read=True))
                if site.archived_at is not None:
                    fail(409, 'PARENT_ARCHIVED', '상위 장소를 먼저 되살리세요.')
        row.archived_at = None
        if kind == 'scenario':
            row.version += 1
        event(db, user.org_id, kind.upper() + '_RESTORED', user.id, {'id': str(row.id), 'name': row.name})
        if kind == 'floor':
            from .maps import refresh_connectors
            db.flush()
            refresh_connectors(db, row)

    @app.delete('/api/v1/trash/{kind}/{identifier}', status_code=204)
    def purge(kind: C.TrashKind, identifier: UUID, auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'O')
        row = own(db, user, kind, identifier)
        if row.archived_at is None:
            fail(409, 'NOT_IN_TRASH', '휴지통으로 옮긴 뒤 완전 삭제하세요.')
        if kind in ('site', 'building'):
            model, fk = (Building, Building.site_id) if kind == 'site' else (Floor, Floor.building_id)
            if db.scalar(select(model.id).where(model.org_id == user.org_id, fk == row.id).limit(1)):
                fail(409, 'HAS_CHILDREN', '하위 항목을 먼저 완전 삭제하세요. 휴지통의 하위 항목도 포함합니다.')
        elif kind == 'scenario':
            require_unused(db, user.org_id, fail, scenario=row)
            if db.scalar(select(Approval.id).join(Assignment,
                    (Approval.target_type == 'assignment') & (Approval.target_id == Assignment.id) &
                    (Approval.org_id == Assignment.org_id)).join(ScenarioVersion,
                    (ScenarioVersion.id == Assignment.scenario_version_id) &
                    (ScenarioVersion.org_id == Assignment.org_id)).where(Approval.org_id == user.org_id,
                    Approval.status == 'PENDING', ScenarioVersion.scenario_id == row.id).limit(1)):
                fail(409, 'RESOURCE_IN_USE', '시나리오 배정 결재 요청을 먼저 처리하거나 취소하세요.')
        else:
            require_unused(db, user.org_id, fail, floor=row)
            # Immutable scenario geometry must never become selectable with a
            # missing floor. Delete dependent scenarios explicitly first.
            if db.scalar(select(ScenarioVersion.id).where(ScenarioVersion.org_id == user.org_id,
                    row.id == any_(ScenarioVersion.floor_ids)).limit(1)):
                fail(409, 'HAS_REFERENCES', '이 층을 참조하는 시나리오를 먼저 휴지통에서 완전 삭제하세요.')
            versions = select(MapVersion.id).where(MapVersion.org_id == user.org_id, MapVersion.floor_id == row.id)
            if db.scalar(select(Approval.id).where(Approval.org_id == user.org_id, Approval.status == 'PENDING',
                    or_(Approval.target_id.in_(versions), Approval.base_ref_id.in_(versions))).limit(1)):
                fail(409, 'RESOURCE_IN_USE', '지도 결재 요청을 먼저 처리하거나 취소하세요.')
        event(db, user.org_id, kind.upper() + '_PURGED', user.id, {'id': str(row.id), 'name': row.name})
        db.flush()
        if kind in ('floor', 'scenario'):
            # Restricted fh_app keeps immutable-table DELETE/UPDATE denied.
            # This narrow definer function validates trash/usage again, then
            # detaches history and deletes only this tenant's dependency tree.
            db.execute(text('SELECT fh_purge_resource(:org, :kind, :id)'),
                {'org': user.org_id, 'kind': kind, 'id': row.id})
        else:
            db.delete(row)
        db.info['trash_files_pending'] = user.org_id

    @app.get('/api/v1/runs/{identifier}/history', response_model=C.RunHistory)
    def history(identifier: UUID, auth: Identity, db: DB):
        user = auth[0]
        run = db.scalar(select(Run).where(Run.org_id == user.org_id, Run.id == identifier))
        if run is None:
            fail(404, 'NOT_FOUND', '임무 기록을 찾을 수 없습니다.')
        robot = db.get(Robot, run.robot_id)
        # Match event-history access: current owner or the original actor.
        if user.role != 'ORG_ADMIN' and robot.owner_user_id != user.id and run.started_by != user.id:
            fail(404, 'NOT_FOUND', '임무 기록을 찾을 수 없습니다.')
        version = db.get(ScenarioVersion, run.scenario_version_id) if run.scenario_version_id else None
        floor = db.get(Floor, run.floor_id) if run.floor_id else None
        return C.RunHistory(**{k: getattr(run, k) for k in C.RunHistory.model_fields if k not in ('scenario_name', 'floor_name')},
            scenario_name=version.name if version else '삭제된 시나리오: ' + (run.scenario_name_snapshot or ''),
            floor_name=floor.name if floor else '삭제된 층: ' + (run.floor_name_snapshot or ''))
