"""Disabled-by-default Go2 SDK boundary. Importing never imports SDK or opens I/O."""

from . import loader  # snapshot before optional SDK/media imports
from .sink import Go2Sink, Limits, OutputError

__all__ = ['Go2Sink', 'Limits', 'OutputError']
