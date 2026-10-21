"""Pytest-only subprocess observer for check_link_mutations.py (not runtime code)."""

import json
from pathlib import Path

import pytest


def pytest_addoption(parser):
    parser.addoption("--link-mutation-report", required=True)


def pytest_configure(config):
    config._link_mutation_result = {"collected": 0, "assertions": [], "errors": []}


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    result = yield
    report = result.get_result()
    if not report.failed:
        return
    exc = call.excinfo.value if call.excinfo is not None else None
    data = item.config._link_mutation_result
    if call.when == "call" and isinstance(exc, (AssertionError, pytest.fail.Exception)):
        data["assertions"].append(item.nodeid)
    else:
        data["errors"].append({"nodeid": item.nodeid, "phase": call.when,
                               "type": type(exc).__name__})

@pytest.hookimpl(hookwrapper=True)
def pytest_make_collect_report(collector):
    result = yield
    report = result.get_result()
    if report.failed:
        collector.config._link_mutation_result["errors"].append({
            "nodeid": report.nodeid, "phase": "collect", "type": "CollectionError"})


def pytest_sessionfinish(session, exitstatus):
    data = session.config._link_mutation_result
    data["collected"] = session.testscollected
    data["exitstatus"] = int(exitstatus)
    if session.testscollected == 0 or int(exitstatus) not in (0, 1):
        data["errors"].append({"nodeid": "<session>", "type": "collection/session error"})
    Path(session.config.getoption("--link-mutation-report")).write_text(json.dumps(data))
