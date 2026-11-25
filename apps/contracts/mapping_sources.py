"""Source adapters own topic assumptions; map geometry/storage is source independent.

Extend MappingSource and ADAPTERS together to add another SLAM provider without
changing voxel, tile, grid, pose or bundle field shapes.
"""
from dataclasses import dataclass
import os
from typing import Literal

MappingSource = Literal['point_lio', 'glim']
DEFAULT_MAPPING_SOURCE: MappingSource = 'point_lio'
DEFAULT_FINAL_SOURCE: MappingSource = 'glim'


@dataclass(frozen=True)
class MappingSourceAdapter:
    cloud_source: str | None
    odom_source: str | None
    service_name: str
    role: Literal['live', 'final']
    service_control_enabled: bool = False

    def accepts_odom(self, source: str) -> bool:
        return self.odom_source is not None and source == self.odom_source


ADAPTERS: dict[str, MappingSourceAdapter] = {
    'point_lio': MappingSourceAdapter(cloud_source='/cloud_registered', odom_source='/aft_mapped_to_init',
        service_name='foothold-pointlio', role='live'),
    'glim': MappingSourceAdapter(cloud_source=None, odom_source=None,
        service_name='foothold-glim', role='final'),
}

DEFAULT_ODOM_SOURCE = ADAPTERS[DEFAULT_MAPPING_SOURCE].odom_source


def mapping_adapter(source: str | None) -> MappingSourceAdapter | None:
    base = ADAPTERS.get(source)
    if base is None:
        return None
    prefix = 'FH_MAPPING_' + source.upper() + '_'
    return MappingSourceAdapter(
        cloud_source=os.environ.get(prefix + 'CLOUD_TOPIC', base.cloud_source) or None,
        odom_source=os.environ.get(prefix + 'ODOM_TOPIC', base.odom_source) or None,
        service_name=os.environ.get(prefix + 'SERVICE', base.service_name), role=base.role,
        service_control_enabled=os.environ.get('FH_MAPPING_SERVICE_CONTROL_ENABLED', '').lower() == 'true')
