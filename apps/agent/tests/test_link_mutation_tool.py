"""Probe mutation verdicts with synthetic pytest results, never mutate the worktree."""

import json
from pathlib import Path
import runpy
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("kind,expected", [
    ("AssertionError", False), ("Failed", False), ("RuntimeError", True),
    ("TypeError", True), ("mixed", True), ("missing_report", True),
])
def test_mutation_verdict_distinguishes_assertions_from_execution_errors(monkeypatch, kind, expected):
    path = Path(__file__).resolve().parents[1] / "tools/check_link_mutations.py"
    namespace = runpy.run_path(str(path))
    main = namespace["main"]
    main.__globals__["MUTATIONS"] = [namespace["MUTATIONS"][0]]

    def fake_pytest(argv, **kwargs):
        # The corrected tool asks a pytest hook for structured exception types.
        # Old summary lines alone make both TypeError and AssertionError look FAILED.
        if "--link-mutation-report" in argv and kind != "missing_report":
            report = Path(argv[argv.index("--link-mutation-report") + 1])
            assertions = ["tests/test_link_session.py::test_probe"] if kind in (
                "AssertionError", "Failed", "mixed") else []
            errors = [] if kind in ("AssertionError", "Failed") else [
                {"nodeid": "tests/test_link_session.py::test_probe", "type": kind}]
            report.write_text(json.dumps({"collected": 1, "exitstatus": 1,
                                          "assertions": assertions, "errors": errors}))
        return SimpleNamespace(returncode=1,
            stdout=f"FAILED tests/test_link_session.py::test_probe - {kind}: probe\n", stderr="")

    monkeypatch.setattr(main.__globals__["subprocess"], "run", fake_pytest)
    assert bool(main()) is expected


@pytest.mark.parametrize("source,assertion,error_type", [
    ("def test_probe():\n    assert False\n", True, None),
    ("import pytest\ndef test_probe():\n    pytest.fail('expected failure')\n", True, None),
    ("def test_probe():\n    raise RuntimeError('unexpected error')\n", False, "RuntimeError"),
])
def test_pytest_observer_records_real_exception_types(tmp_path, source, assertion, error_type):
    import shutil
    import subprocess
    import sys

    root = Path(__file__).resolve().parents[1]
    shutil.copyfile(root / "tools/mutation_reporter.py", tmp_path / "foothold_link_mutation_probe.py")
    (tmp_path / "test_probe.py").write_text(source)
    report = tmp_path / "probe.json"
    result = subprocess.run([sys.executable, "-m", "pytest", "test_probe.py", "-q", "--tb=no",
        "-p", "foothold_link_mutation_probe", "--link-mutation-report", str(report)],
        cwd=tmp_path, capture_output=True, text=True, timeout=10)
    assert result.returncode == 1, result.stdout + result.stderr
    data = json.loads(report.read_text())
    assert bool(data["assertions"]) is assertion and data["collected"] == 1
    assert ([error["type"] for error in data["errors"]] == [error_type]
            if error_type else not data["errors"])


def test_observer_does_not_hide_collection_error_when_assertions_also_fail(tmp_path):
    import shutil
    import subprocess
    import sys

    root = Path(__file__).resolve().parents[1]
    shutil.copyfile(root / "tools/mutation_reporter.py", tmp_path / "foothold_link_mutation_probe.py")
    (tmp_path / "test_assertion.py").write_text("def test_probe():\n    assert False\n")
    (tmp_path / "test_broken.py").write_text("invalid python syntax :\n")
    report = tmp_path / "probe.json"
    result = subprocess.run([sys.executable, "-m", "pytest", "-q", "--tb=no",
        "--continue-on-collection-errors", "-p", "foothold_link_mutation_probe",
        "--link-mutation-report", str(report)], cwd=tmp_path, capture_output=True,
        text=True, timeout=10)
    assert result.returncode == 1
    data = json.loads(report.read_text())
    assert data["assertions"] and data["errors"]
    assert any(error.get("phase") == "collect" for error in data["errors"])
