import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from apps.server.tools import check_realtime_mutations as tool


@pytest.mark.parametrize('kind,expected', [('assertion', 1), ('runtime', 2), ('mixed', 2), ('missing', 2)])
def test_mutation_tool_only_counts_assertions(tmp_path, monkeypatch, kind, expected):
    def fake(argv, **kw):
        if kind != 'missing':
            report = Path(argv[argv.index('--realtime-mutation-report') + 1])
            report.write_text(json.dumps({'collected': 1, 'exitstatus': 1,
                'assertions': ['test::expected'] if kind in ('assertion', 'mixed') else [],
                'errors': [] if kind == 'assertion' else [{'type': 'RuntimeError'}]}))
        return SimpleNamespace(returncode=1, stdout='1 failed', stderr='')
    monkeypatch.setattr(tool.subprocess, 'run', fake)
    assert tool.run(tmp_path, ['test'])[0] == expected
