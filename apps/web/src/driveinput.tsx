// 조종 화면 위 「에이전트가 조종을 막은 까닭」 한 줄(u11_4 · U11-05). 에이전트는 화면 조종이 막힌 까닭(리모컨 우선 · 중립 기다림 · 비상정지 등)을
// 장치 줄 key 'go2-drive-input' 의 label 로 보낸다(agent link/session.py _devices · go2_direct/sink.py movement_reason).
// 웹은 그 글을 그대로 보일 뿐 글을 짓거나 STOP 에 대한 약속을 덧붙이지 않는다. label 이 비었거나 줄이 없으면 안 띄운다.
// 오래된 상태의 글을 보이지 않는 것은 부르는 쪽 몫(새 상태의 devices 만 넘긴다).
import type { Device } from '../../contracts/ts';

export const DRIVE_INPUT_KEY = 'go2-drive-input';

export function DriveInputNote({ devices }: { devices?: readonly Device[] | null }) {
  const text = devices?.find((d) => d.key === DRIVE_INPUT_KEY)?.label?.trim();
  return text ? <p className="dv-note" role="status" data-drive-input>{text}</p> : null;
}
