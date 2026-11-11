"""Closed polygon rules shared by editing, scenario checks and sparse grids.

No robot radius, navigation policy or real-device control belongs here.
"""
import math
from types import SimpleNamespace
from typing import Annotated
from uuid import UUID

from fastapi import Query, Response
from sqlalchemy import any_, select

from apps.contracts import models as C
from .maps import bounded_features, intersects, orientation, validate_features
from .models import Floor, MapVersion, Scenario, ScenarioVersion, Upload


def inside_polygon(x, y, polygon):
    # Boundary belongs to NO_GO too. Same rule as missions.preview.
    inside = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if abs(orientation(a, b, (x, y))) <= 1e-10 and min(a[0], b[0]) <= x <= max(a[0], b[0]) and min(a[1], b[1]) <= y <= max(a[1], b[1]):
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def segment_touches(a, b, polygon):
    return (inside_polygon(*a, polygon) or inside_polygon(*b, polygon)
        or any(intersects(a, b, c, d) for c, d in zip(polygon, polygon[1:] + polygon[:1])))


def row_spans(y, polygon, width):
    """Projection of polygon intersection with a closed one-cell-high strip.

    A vertical ray through an intersecting x either meets polygon boundary in
    the strip, or stays inside for its full height (and contains the midpoint).
    Union of clipped edge projections and midpoint interior spans is therefore
    exact, including concavity, thin slivers, corner touches and horizontal edges.
    This scans edges per row, rather than per cell, on 600x600 twin rasters.
    """
    intervals, crossings = [], []
    mid = y + .5
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[1] > mid) != (b[1] > mid):
            crossings.append(a[0] + (mid - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
        if max(a[1], b[1]) < y or min(a[1], b[1]) > y + 1:
            continue
        if a[1] == b[1]:
            intervals.append(sorted((a[0], b[0])))
        else:
            low, high = max(y, min(a[1], b[1])), min(y + 1, max(a[1], b[1]))
            intervals.append(sorted(a[0] + (bound - a[1]) * (b[0] - a[0]) / (b[1] - a[1]) for bound in (low, high)))
    crossings.sort()
    intervals.extend([low, high] for low, high in zip(crossings[::2], crossings[1::2]))
    spans = []
    for low, high in sorted(intervals):
        left, right = max(0, math.ceil(low - 1e-10) - 1), min(width - 1, math.floor(high + 1e-10))
        if right < left:
            continue
        if spans and left <= spans[-1][1] + 1:
            spans[-1][1] = max(spans[-1][1], right)
        else:
            spans.append([left, right])
    return spans


def rasterize(origin, resolution, width, height, zones):
    """Sparse top-down row-major cells; closed squares include edge/corner touch.

    Transform to this map's own grid, including rotated origins. Integer snapping
    removes roundoff at exact cell boundaries (1e-9 cell); no body inflation.
    """
    ox, oy, yaw = origin
    cosine, sine = math.cos(yaw), math.sin(yaw)
    def snap(value):
        nearest = round(value)
        return float(nearest) if abs(value - nearest) <= 1e-9 else value
    cells = {}
    for zone in zones:
        polygon = [[snap((cosine * (x - ox) + sine * (y - oy)) / resolution),
                    snap((-sine * (x - ox) + cosine * (y - oy)) / resolution)] for x, y in zone['polygon']]
        bottom = max(0, math.ceil(min(p[1] for p in polygon)) - 1)
        top = min(height - 1, math.floor(max(p[1] for p in polygon)))
        for y in range(bottom, top + 1):
            for left, right in row_spans(y, polygon, width):
                for x in range(left, right + 1):
                    index = (height - 1 - y) * width + x
                    cell = cells.setdefault(index, dict(index=index, no_go=False, slow=False, max_speed_mps=None))
                    if zone['type'] == 'NO_GO':
                        cell['no_go'] = True
                    else:
                        cell['slow'] = True
                        speed = zone.get('max_speed_mps')
                        if speed is not None:
                            cell['max_speed_mps'] = min(speed, cell['max_speed_mps']) if cell['max_speed_mps'] is not None else speed
    # A blocked cell never advertises a traversable speed. slow still records
    # presence of a slow zone, including legacy zones with unspecified speed.
    for cell in cells.values():
        if cell['no_go']:
            cell['max_speed_mps'] = None
    return [cells[index] for index in sorted(cells)]


def scenario_geometry(db, snapshot, replacements=None):
    """Fixed route endpoints plus shortest direct connector approaches.

    Use snapshot features, not mutable FloorConnector projections, so annotation
    drafts and historical scenarios can be inspected without writing or preview.
    """
    replacements = replacements or {}
    points = [(f'waypoints.{i}', dict(p)) for i, p in enumerate(snapshot.waypoints)]
    if snapshot.finish.get('mode') == 'GO_TO':
        points.append(('finish.target', dict(snapshot.finish['target'])))
    versions = {str(v.id): v for v in db.scalars(select(MapVersion).where(
        MapVersion.org_id == snapshot.org_id, MapVersion.id.in_(snapshot.map_version_ids)))}
    def features(point):
        return replacements.get(str(point['floor_id']), versions[str(point['map_version_id'])].features)
    routes = list(zip(points, points[1:]))
    if snapshot.finish.get('mode') == 'RETURN_TO_START':
        routes.append((points[-1], points[0]))
    endpoints = list(points)
    segments = []
    for (start, a), (end, b) in routes:
        if str(a['floor_id']) == str(b['floor_id']):
            segments.append((f'{start}->{end}', a, b))
            continue
        candidates = []
        for ca in features(a)['connectors']:
            if any(z['type'] == 'NO_GO' and inside_polygon(ca['x'], ca['y'], z['polygon']) for z in features(a)['zones']):
                continue
            if str(ca['pair_floor_id']) != str(b['floor_id']):
                continue
            for cb in features(b)['connectors']:
                if any(z['type'] == 'NO_GO' and inside_polygon(cb['x'], cb['y'], z['polygon']) for z in features(b)['zones']):
                    continue
                if ca['id'] != cb['id'] or ca['kind'] != cb['kind'] or str(cb['pair_floor_id']) != str(a['floor_id']):
                    continue
                pa = dict(ca, floor_id=a['floor_id'], map_version_id=a['map_version_id'])
                pb = dict(cb, floor_id=b['floor_id'], map_version_id=b['map_version_id'])
                length = math.hypot(a['x'] - pa['x'], a['y'] - pa['y']) + math.hypot(b['x'] - pb['x'], b['y'] - pb['y'])
                candidates.append((length, ca['id'], pa, pb))
        if candidates:
            _, connector_id, pa, pb = min(candidates, key=lambda item: (item[0], item[1]))
            ae, be = f'{start}->{end}.via.0:{connector_id}', f'{start}->{end}.via.1:{connector_id}'
            endpoints.extend([(ae, pa), (be, pb)])
            segments.extend([(f'{start}->{ae}', a, pa), (f'{be}->{end}', pb, b)])
    return endpoints, segments


def overlap_hits(db, snapshot, floor_id, features):
    points, segments = scenario_geometry(db, snapshot)
    hits = []
    for zone in features['zones']:
        if zone['type'] != 'NO_GO':
            continue
        for element, point in points:
            if str(point['floor_id']) == str(floor_id) and inside_polygon(point['x'], point['y'], zone['polygon']):
                hits.append(C.ZoneOverlapHit(kind='POINT', element=element, zone_id=zone['id']))
        for element, a, b in segments:
            if str(a['floor_id']) == str(floor_id) and segment_touches((a['x'], a['y']), (b['x'], b['y']), zone['polygon']):
                hits.append(C.ZoneOverlapHit(kind='SEGMENT', element=element, zone_id=zone['id']))
    return hits


def install(app, DB, Identity, fail):
    def own(db, user, model, identifier):
        row = db.scalar(select(model).where(model.org_id == user.org_id, model.id == identifier))
        if row is None:
            fail(404, 'NOT_FOUND', '지도 또는 층을 찾을 수 없습니다.')
        return row

    @app.get('/api/v1/map-versions/{version_id}/zone-grid', response_model=C.ZoneGrid)
    def grid(version_id: UUID, response: Response, auth: Identity, db: DB,
             cursor: Annotated[int, Query(ge=0)] = 0,
             limit: Annotated[int, Query(ge=1, le=20_000)] = 20_000):
        row = own(db, auth[0], MapVersion, version_id)
        origin = (row.origin_x, row.origin_y, row.origin_yaw)
        cells = rasterize(origin, row.resolution, row.width, row.height, bounded_features(row, fail)['zones'])
        chunk = cells[cursor:cursor + limit]
        following = cursor + len(chunk)
        response.headers['Cache-Control'] = 'private, no-store'
        return C.ZoneGrid(map_version_id=row.id, origin=origin, resolution=row.resolution,
            width=row.width, height=row.height, cursor=cursor, cells=chunk,
            next_cursor=following if following < len(cells) else None)

    @app.get('/api/v1/map-versions/{version_id}/simulation-twin', response_model=C.MapSimulationTwin)
    def twin(version_id: UUID, auth: Identity, db: DB):
        from .voxel_links import voxel_summary
        from .voxel_maps import simulation_twin
        version = own(db, auth[0], MapVersion, version_id)
        image = own(db, auth[0], Upload, version.upload_id)
        summary = voxel_summary(db, version, image)
        if not summary or summary.get('map_version_id') != str(version.id):
            fail(404, 'NOT_FOUND', '이 지도 판과 연결된 시뮬 지형이 없습니다.')
        # Resolve the same immutable twin as the agent, without acquiring or
        # operating a robot. Its world constraint comes from server metadata.
        identity = SimpleNamespace(org_id=auth[0].org_id, sim_world_id='custom/' + summary['terrain_id'])
        floor_id, twin_id = simulation_twin(db, identity, version.floor_id, version.id, fail)
        return C.MapSimulationTwin(map_version_id=version.id, simulation_map_version_id=twin_id,
            simulation_floor_id=floor_id, terrain_id=summary['terrain_id'])

    @app.post('/api/v1/floors/{floor_id}/zone-overlaps', response_model=C.ZoneOverlaps)
    def overlaps(floor_id: UUID, body: C.ZoneOverlapRequest, auth: Identity, db: DB):
        floor = own(db, auth[0], Floor, floor_id)
        if floor.archived_at is not None or floor.approved_version_id is None:
            fail(409, 'RESOURCE_ARCHIVED', '사용할 수 있는 승인 지도가 없습니다.')
        version = own(db, auth[0], MapVersion, floor.approved_version_id)
        image = own(db, auth[0], Upload, version.upload_id)
        validate_features(db, floor, image, body.features, fail)
        scenarios = db.scalars(select(ScenarioVersion).join(Scenario,
            (Scenario.id == ScenarioVersion.scenario_id) & (Scenario.org_id == ScenarioVersion.org_id)
            & (Scenario.latest_version == ScenarioVersion.number)).where(Scenario.org_id == auth[0].org_id,
                Scenario.archived_at.is_(None), floor_id == any_(ScenarioVersion.floor_ids)).order_by(Scenario.id))
        result = []
        for snapshot in scenarios:
            hits = overlap_hits(db, snapshot, floor_id, body.features.model_dump(mode='json', exclude_none=True))
            if hits:
                result.append(C.ZoneOverlapScenario(scenario_id=snapshot.scenario_id, scenario_name=snapshot.name, hits=hits))
        return C.ZoneOverlaps(scenarios=result)
