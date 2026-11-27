"""Numbers measured from real Go2 X traces. Recompute with measure.py.

Source: /home/jay/data/overnight-1122/jetson-logs/trace-pull-1125/
        start-*.jsonl (42) + factory-auto-*.jsonl (86), 2026-11-23..25, read only.
Measured 2026-11-26 with `python3 -m foothold_agent.demo.measure <those files>`:
50 files usable (rows cover >= 80 % of the SOC span),
lie 7.88 h, stand 3.42 h, walk 0.77 h of classified rows.

Least squares soc_drop = r_lie*t_lie + r_stand*t_stand + r_walk*t_walk:
    lie 22.0 %/h, stand 34.6 %/h, walk 92.1 %/h
Walking is the least covered class (0.77 h), so its rate is the least certain.
Battery current field `bat.a` does not agree with the SOC slope (0.3 A lying
would not drain 22 %/h), so it is not used.

Charging is NOT measured: Go2 X does not charge while powered on, so no trace
contains charging. Chargers must state charge_pct_per_h in the scenario.

Voltage: least squares over 54 per-file medians, v = 26.488 + 0.0490 * soc
(max residual 0.84 V). Joint temperature over all files 19..65 degC
(walk rows 21..53, stand/lie rows 19..65; hottest stand rows follow long walks).
"""

DRAIN_PCT_PER_H = {'lie': 22.0, 'stand': 34.6, 'walk': 92.1}
VOLTAGE_V = (26.488, 0.0490)  # v = a + b * soc


def voltage(soc):
    return round(VOLTAGE_V[0] + VOLTAGE_V[1] * soc, 2)
