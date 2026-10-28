"""Go2 observation only. Importing this package never joins DDS or opens a socket."""

from .state import State

__all__ = ['State']
