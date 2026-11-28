"""Ports come from .env; the example carries no secrets; Compose passes seed values."""
from pathlib import Path
import re

from docker import seed


REPOSITORY = Path(__file__).resolve().parents[1]


def example():
    values = {}
    for line in (REPOSITORY / '.env.example').read_text().splitlines():
        if line.strip() and not line.startswith('#'):
            key, _, value = line.partition('=')
            values[key] = value
    return values


def test_example_has_no_secret_values():
    values = example()
    secret = [key for key in values if re.search(r'PASSWORD|SECRET|TOKEN|KEY', key)]
    assert set(seed.BOOTSTRAP_KEYS) <= set(secret)
    assert {key: values[key] for key in secret} == {key: '' for key in secret}


def test_example_ports_are_numbers_and_origin_follows_web_port():
    values = example()
    for key in ('FH_WEB_PORT', 'FH_API_PORT', 'FH_DB_PORT'):
        assert values[key].isdigit() and 1024 <= int(values[key]) <= 65535, key
    assert values['FH_WS_ORIGIN'] == 'http://localhost:${FH_WEB_PORT}'
    assert values['FH_SEED'] in ('0', '1')


def test_compose_host_ports_all_from_env_and_seed_passed():
    compose = (REPOSITORY / 'compose.yaml').read_text()
    published = re.findall(r"^\s+- '([^']*:\d+)'$", compose, re.M)
    assert published and all(re.fullmatch(r'127\.0\.0\.1:\$\{FH_\w+_PORT:-\d+\}:\d+', p) for p in published)
    for key in ('FH_SEED', *(seed.password_key(name) for name, *_ in seed.ACCOUNTS)):
        assert re.search(rf'^\s+{key}: \$\{{{key}:-', compose, re.M), key
