"""Pytest subprocess reporter: assertion failures kill; runtime errors do not."""
import json
from pathlib import Path

import pytest


def pytest_addoption(parser):
    parser.addoption('--sim-mutation-report', required=True)


def pytest_configure(config):
    config._sim_result = {'collected': 0, 'assertions': [], 'errors': []}


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    result = yield
    if not result.get_result().failed:
        return
    exc = call.excinfo.value if call.excinfo is not None else None
    record = item.config._sim_result
    if call.when == 'call' and isinstance(exc, (AssertionError, pytest.fail.Exception)):
        record['assertions'].append(item.nodeid)
    else:
        record['errors'].append({'test': item.nodeid, 'phase': call.when, 'type': type(exc).__name__})


@pytest.hookimpl(hookwrapper=True)
def pytest_make_collect_report(collector):
    result = yield
    if result.get_result().failed:
        collector.config._sim_result['errors'].append({'test': collector.nodeid, 'phase': 'collection'})


def pytest_sessionfinish(session, exitstatus):
    data = session.config._sim_result
    data.update(collected=session.testscollected, exitstatus=int(exitstatus))
    if session.testscollected == 0 or int(exitstatus) not in (0, 1):
        data['errors'].append({'phase': 'session'})
    Path(session.config.getoption('--sim-mutation-report')).write_text(json.dumps(data))
