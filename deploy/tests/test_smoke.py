"""Fake transport probes: no private inputs, installed WS client, or network."""
import http.cookiejar
import importlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError


class SmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Exercise our orchestration even when the optional transport is absent.
        with patch.dict('sys.modules', {'websockets.sync.client': SimpleNamespace(connect=Mock())}):
            cls.smoke = importlib.import_module('deploy.smoke')

    def test_main_reaches_opener_open(self):
        failure = RuntimeError('fake opener reached')
        opener = Mock()
        opener.open.side_effect = failure
        with patch.object(self.smoke, 'private_env', return_value={'FH_SITE': 'smoke-test'}), \
                patch.object(self.smoke, 'build_opener', return_value=opener), \
                patch.object(self.smoke.time, 'sleep'):
            with self.assertRaises(RuntimeError) as raised:
                self.smoke.main()
        self.assertIs(raised.exception, failure)
        opener.open.assert_called()

    def check_session(self, ws_failure=False):
        jar = [SimpleNamespace(name='fh_s', value='fake-check-session')]
        opened = []
        def response(status, body=b''):
            result = Mock(status=status)
            result.read.return_value = body
            result.__enter__ = Mock(return_value=result)
            result.__exit__ = Mock(return_value=False)
            return result
        def open_request(request, **kwargs):
            opened.append(request)
            if isinstance(request, str):
                if request.endswith('/session'):
                    raise HTTPError(request, 401, '', {}, None)
                return response(200, b'<html>fake</html>')
            if request.full_url.endswith('/login'):
                self.assertEqual(json.loads(request.data)['username'], 'fake-check')
                return response(200, b'{"csrf_token":"fake-csrf"}')
            self.assertTrue(request.full_url.endswith('/logout'))
            self.assertEqual(request.get_header('X-fh-csrf'), 'fake-csrf')
            return response(204)
        opener = Mock()
        opener.open.side_effect = open_request
        def private(path):
            if str(path).endswith('/site.env'):
                return {'FH_SITE': 'smoke.example.org'}
            self.assertEqual(str(path), '/etc/foothold/smoke.env')
            return {'FH_SMOKE_USERNAME': 'fake-check', 'FH_SMOKE_PASSWORD': 'fake-password'}
        ws = Mock()
        ws.__enter__ = Mock(return_value=SimpleNamespace(response=SimpleNamespace(status_code=101)))
        ws.__exit__ = Mock(return_value=False)
        with patch.object(self.smoke, 'private_env', side_effect=private), \
                patch.object(self.smoke.http.cookiejar, 'CookieJar', return_value=jar), \
                patch.object(self.smoke, 'build_opener', return_value=opener), \
                patch.object(self.smoke, 'connect', side_effect=RuntimeError('fake WS error') if ws_failure else None,
                             return_value=ws) as connect:
            if ws_failure:
                with self.assertRaises(RuntimeError):
                    self.smoke.main()
            else:
                self.smoke.main()
            connect.assert_called_once()
            self.assertEqual(connect.call_args.kwargs['additional_headers'], {'Cookie': 'fh_s=fake-check-session'})
        self.assertEqual(len(opened), 4)  # readiness, 401, dedicated login, logout

    def test_dedicated_account_and_logout(self):
        self.check_session()

    def test_ws_failure_still_logs_out(self):
        self.check_session(ws_failure=True)


if __name__ == '__main__':
    unittest.main()
