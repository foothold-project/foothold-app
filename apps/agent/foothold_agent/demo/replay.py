"""Joint angles and temperatures replayed from real Go2 X traces.

index() cuts the 50 Hz runner traces into clips by activity (lie / stand / walk,
same rule as measure.activity) and stores them downsampled (q at 10 Hz, joint
temperature at 1 Hz) in SDK order, ready for Go2Joints / Go2Temperature. No
values are synthesized: a robot plays a recorded clip of its current activity.
Clip choice is deterministic: the clip whose first temperature is closest to
the robot's last reported temperature, so switching activity does not jump.

    python3 -m foothold_agent.demo index OUT.json TRACE_DIR/start-*.jsonl TRACE_DIR/factory-auto-*.jsonl
"""
import json
import math
import os

from .measure import activity, to_sdk

VERSION = 1
Q_HZ = 10
CLIP_S = 60.0
MIN_CLIP_S = 10.0
ACTIVITIES = ('lie', 'stand', 'walk')


def _attitude(grav):
    """roll/pitch from the body-frame gravity unit vector ([0, 0, -1] upright)."""
    if not (isinstance(grav, list) and len(grav) == 3):
        return None
    gx, gy, gz = grav
    return [round(math.atan2(-gy, -gz), 4), round(math.asin(max(-1.0, min(1.0, gx))), 4)]


def index(paths, *, clip_s=CLIP_S, min_clip_s=MIN_CLIP_S):
    clips = {a: [] for a in ACTIVITIES}
    for path in paths:
        current = None

        def close():
            if current and current['rows'] and current['rows'][-1][0] - current['rows'][0][0] >= min_clip_s:
                clips[current['kind']].append(_pack(current))

        last_q_t = None
        with open(path, 'rb') as fh:
            for raw in fh:
                if b'"phase"' not in raw:
                    continue
                try:
                    row = json.loads(raw)
                except ValueError:
                    continue
                t = row.get('t')
                kind = activity(row)
                q, temp = row.get('q'), row.get('temp')
                ok = (isinstance(t, (int, float)) and kind is not None and isinstance(q, list)
                      and len(q) == 12 and isinstance(temp, list) and len(temp) == 12)
                if not ok or (current and (current['kind'] != kind or t - current['rows'][-1][0] > 0.5)):
                    close()
                    current = None
                    if not ok:
                        continue
                if current is None:
                    current = dict(kind=kind, file=os.path.basename(path), rows=[])
                    last_q_t = None
                if last_q_t is not None and t - last_q_t < 1 / Q_HZ - 1e-3:
                    continue
                last_q_t = t
                battery = row.get('bat') if isinstance(row.get('bat'), dict) else {}
                sport = row.get('sport') if isinstance(row.get('sport'), dict) else {}
                current['rows'].append((t, q, temp, _attitude(row.get('grav')),
                                        (battery.get('bq_c') or []) + (battery.get('mcu_c') or []),
                                        sport.get('err')))
                if t - current['rows'][0][0] >= clip_s:
                    close()
                    current = None
        close()
    return dict(version=VERSION, q_hz=Q_HZ, joint_order='sdk', clips=clips,
                sources=sorted({c['file'] for a in clips.values() for c in a}))


def _pack(clip):
    rows = clip['rows']
    t0 = rows[0][0]
    temps, batt = [], []
    for t, _, temp, _, bat, _ in rows:
        if len(temps) <= (t - t0):  # 1 Hz
            temps.append([int(round(v)) for v in to_sdk(temp)])
            batt.append([int(round(v)) for v in bat[:4]] if len(bat) >= 4 else None)
    return dict(file=clip['file'], t0=round(t0, 3), seconds=round(rows[-1][0] - t0, 2),
                q=[[round(v, 4) for v in to_sdk(r[1])] for r in rows],
                attitude=[r[3] for r in rows], temp=temps, battery_temp=batt,
                error_code=next((r[5] for r in rows if type(r[5]) is int), None))


def write(library, path):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(library, fh, separators=(',', ':'))
    os.replace(tmp, path)


def load(path):
    with open(path, encoding='utf-8') as fh:
        library = json.load(fh)
    if library.get('version') != VERSION or library.get('joint_order') != 'sdk':
        raise ValueError('unsupported replay library')
    return library


class Player:
    """One robot's replay head. advance() returns a sample of the current clip."""

    def __init__(self, library, offset=0):
        self.library = library
        self.offset = offset  # spreads robots across equally good clips
        self.kind = self.wanted = None
        self.clip = None
        self.pos = 0.0
        self.last_temp = None
        self.fallbacks = 0

    def _clips(self, kind):
        clips = self.library['clips']
        if clips.get(kind):
            return kind, clips[kind]
        # Recorded data may lack an activity (e.g. no lying clip); stand is the
        # recorded posture nearest to both lie and walk. Counted for the report.
        self.fallbacks += 1
        for alt in ('stand', 'lie', 'walk'):
            if clips.get(alt):
                return alt, clips[alt]
        raise ValueError('replay library has no clips')

    def _choose(self, kind):
        kind, clips = self._clips(kind)
        if self.clip is not None and kind == self.kind:
            # Same activity goes on: continue the same recording, so its real
            # heating / cooling trend carries on instead of restarting a clip.
            end = self.clip['t0'] + self.clip['seconds']
            following = next((c for c in clips if c['file'] == self.clip['file']
                              and 0 <= c['t0'] - end <= 0.5), None)
            if following is not None:
                self.clip, self.pos = following, 0.0
                return
        if self.last_temp is None:
            index = self.offset % len(clips)
        else:
            target = sum(self.last_temp) / 12
            ranked = sorted(range(len(clips)), key=lambda i: (
                round(abs(sum(clips[i]['temp'][0]) / 12 - target)), (i - self.offset) % len(clips)))
            index = ranked[0]
            if clips[index] is self.clip and len(ranked) > 1:
                index = ranked[1]  # do not loop the same clip back to back
        self.kind, self.clip, self.pos = kind, clips[index], 0.0

    def advance(self, kind, dt):
        if self.clip is None or kind != self.wanted:
            self.wanted = kind
            self._choose(kind)
        else:
            self.pos += max(0.0, dt)
            if self.pos >= len(self.clip['q']) / self.library['q_hz']:
                self._choose(kind)
        clip = self.clip
        qi = min(int(self.pos * self.library['q_hz']), len(clip['q']) - 1)
        ti = min(int(self.pos), len(clip['temp']) - 1)
        self.last_temp = clip['temp'][ti]
        return dict(activity=self.kind, file=clip['file'], t=clip['t0'] + self.pos,
                    positions=list(clip['q'][qi]), attitude=clip['attitude'][qi],
                    joint_temp=list(clip['temp'][ti]), battery_temp=clip['battery_temp'][ti],
                    error_code=clip['error_code'])
