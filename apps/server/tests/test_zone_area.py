"""AREA zones name a place and change no movement rule (app-design-lx 11/28 14:14 condition 1, 3).

- zone grid (planner · simulator · agent read only this): same cells with and without AREA
- location label: smallest named zone containing the point, ties by zone id, boundary counts as inside
"""
import copy

from apps.server.fh_server.zones import location_zone, rasterize

ORIGIN, RES, W, H = (0.0, 0.0, 0.0), 0.5, 40, 40
NO_GO = {'id': 'n1', 'type': 'NO_GO', 'name': '변전소', 'polygon': [[2, 2], [6, 2], [6, 6], [2, 6]]}
SLOW = {'id': 's1', 'type': 'SLOW', 'name': '감속', 'polygon': [[8, 8], [14, 8], [14, 14], [8, 14]], 'max_speed_mps': 0.5}
AREAS = [
    {'id': 'a-big', 'type': 'AREA', 'name': '탱크 마당 1 동쪽', 'polygon': [[0, 0], [20, 0], [20, 20], [0, 20]]},
    {'id': 'a-road', 'type': 'AREA', 'name': '제어실 앞 주도로', 'polygon': [[1, 1], [7, 1], [7, 7], [1, 7]]},
    {'id': 'a-x', 'type': 'AREA', 'name': '공정 C 배관 밑', 'polygon': [[9, 9], [11, 9], [11, 11], [9, 11]]},
]


def test_area_zones_add_no_cell_to_the_zone_grid():
    base = [NO_GO, SLOW]
    with_area = copy.deepcopy(base) + copy.deepcopy(AREAS)
    assert rasterize(ORIGIN, RES, W, H, with_area) == rasterize(ORIGIN, RES, W, H, base)
    assert rasterize(ORIGIN, RES, W, H, copy.deepcopy(AREAS)) == []


def test_area_order_does_not_change_the_grid():
    mixed = [AREAS[0], NO_GO, AREAS[1], SLOW, AREAS[2]]
    assert rasterize(ORIGIN, RES, W, H, mixed) == rasterize(ORIGIN, RES, W, H, [NO_GO, SLOW])


def test_location_is_the_smallest_named_zone_of_any_type():
    zones = [NO_GO, SLOW] + AREAS
    assert location_zone(zones, 4, 4)['id'] == 'n1'      # 16 m2 NO_GO inside 36 m2 road inside 400 m2 yard
    assert location_zone(zones, 1.5, 1.5)['id'] == 'a-road'
    assert location_zone(zones, 10, 10)['id'] == 'a-x'    # 4 m2 AREA inside 36 m2 SLOW
    assert location_zone(zones, 12, 12)['id'] == 's1'
    assert location_zone(zones, 18, 18)['id'] == 'a-big'
    assert location_zone(zones, 25, 25) is None


def test_location_boundary_counts_as_inside():
    zones = [AREAS[1], AREAS[0]]
    assert location_zone(zones, 7, 4)['id'] == 'a-road'   # on the road's east edge
    assert location_zone(zones, 1, 1)['id'] == 'a-road'   # on its corner
    assert location_zone(zones, 20, 10)['id'] == 'a-big'  # on the yard's edge


def test_location_tie_on_area_goes_to_the_first_zone_id():
    same = [[30, 30], [32, 30], [32, 32], [30, 32]]
    zones = [{'id': 'b', 'type': 'AREA', 'name': '둘째', 'polygon': same},
             {'id': 'a', 'type': 'SLOW', 'name': '첫째', 'polygon': same, 'max_speed_mps': 1.0}]
    assert location_zone(zones, 31, 31)['id'] == 'a'
    assert location_zone(list(reversed(zones)), 31, 31)['id'] == 'a'


def test_location_area_of_a_concave_zone_uses_its_true_area():
    ell = {'id': 'z-ell', 'type': 'AREA', 'name': 'ㄱ자', 'polygon': [[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10]]}
    box = {'id': 'z-box', 'type': 'AREA', 'name': '상자', 'polygon': [[0, 0], [5, 0], [5, 5], [0, 5]]}
    assert location_zone([ell, box], 0.5, 0.5)['id'] == 'z-ell'   # 19 m2 < 25 m2 though its bounds are larger
