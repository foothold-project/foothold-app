"""Bounded JPEG REST work off the Hub loop; receipts are the only success proof."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime
import json
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import UUID


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('redirect refused')


def validate_receipt(receipt, metadata):
    if (not isinstance(receipt, dict)
            or set(receipt) != set(metadata) | {'photo_id', 'stored_at'}
            or any(receipt[k] != v for k, v in metadata.items() if k != 'captured_at')):
        raise ValueError('photo receipt does not match request')
    if str(UUID(receipt['photo_id'])) != receipt['photo_id']:
        raise ValueError('invalid photo identity')
    captured = datetime.fromisoformat(receipt['captured_at'].replace('Z', '+00:00'))
    requested = datetime.fromisoformat(metadata['captured_at'].replace('Z', '+00:00'))
    if captured != requested:
        raise ValueError('photo capture time differs from request')
    stored = datetime.fromisoformat(receipt['stored_at'].replace('Z', '+00:00'))
    if captured.utcoffset() is None or stored.utcoffset() is None or stored < captured:
        raise ValueError('invalid receipt time')
    return deepcopy(receipt)


class PhotoClient:
    def __init__(self, origin, token):
        # Reuse the scenario origin validator, without starting another worker.
        from .scenario import validate_origin
        self.origin = validate_origin(origin)
        self.token = token
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='photo-upload')
        self.pending = None

    def upload(self, metadata, payload):
        if self.pending is not None and not self.pending.done():
            raise RuntimeError('photo upload worker busy')
        metadata, payload = deepcopy(metadata), bytes(payload)
        def send():
            request = Request(self.origin + '/api/v1/agent/photos', data=payload, method='POST',
                headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'image/jpeg',
                         'X-Photo-Metadata': json.dumps(metadata, separators=(',', ':'))})
            with build_opener(NoRedirect).open(request, timeout=3) as reply:
                if reply.status != 200:
                    raise ValueError('missing photo commit receipt')
                raw = reply.read(8193)
            if len(raw) > 8192:
                raise ValueError('photo receipt too large')
            from foothold_agent.phone.tickets import json_object
            return validate_receipt(json_object(raw), metadata)
        self.pending = self.pool.submit(send)
        return self.pending

    def close(self):
        self.pool.shutdown(wait=False, cancel_futures=True)
