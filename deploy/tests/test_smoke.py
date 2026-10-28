"""Exercise smoke startup without private inputs or real network access."""
import importlib
import unittest
from unittest.mock import Mock, patch


class SmokeStartupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.smoke = importlib.import_module('deploy.smoke')
        except ModuleNotFoundError as error:
            if error.name == 'websockets' or error.name.startswith('websockets.'):
                raise unittest.SkipTest('websockets sync client is not installed') from error
            raise

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


if __name__ == '__main__':
    unittest.main()
