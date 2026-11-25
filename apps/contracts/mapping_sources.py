"""Source adapters own topic assumptions; map geometry/storage is source independent.

Extend MappingSource and ADAPTERS together to add another SLAM provider without
changing voxel, tile, grid, pose or bundle field shapes.
"""
from dataclasses import dataclass
from typing import Literal

MappingSource = Literal['unitree_uslam']
DEFAULT_MAPPING_SOURCE: MappingSource = 'unitree_uslam'


@dataclass(frozen=True)
class MappingSourceAdapter:
    odom_source: str

    def accepts_odom(self, source: str) -> bool:
        return source == self.odom_source


ADAPTERS: dict[str, MappingSourceAdapter] = {
    'unitree_uslam': MappingSourceAdapter(odom_source='/uslam/frontend/odom'),
}

DEFAULT_ODOM_SOURCE = ADAPTERS[DEFAULT_MAPPING_SOURCE].odom_source


def mapping_adapter(source: str | None) -> MappingSourceAdapter | None:
    return ADAPTERS.get(source)
