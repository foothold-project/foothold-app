# Rootfs guard 검색권한과 제한된 복구

`prepare`는 umask에 관계없이 GUARD를 `root:<dedicated sim gid> 0710`으로 만든다.
시뮬 UID에는 알려진 이름으로 진입하는 검색권한만 필요하다. 디렉터리 쓰기와 목록 읽기는
필요하지 않다. 실제 쓰기는 기존 `deploy.lock`의 `root:<sim gid> 0660`과
`state/`의 `<sim uid>:<sim gid> 0700`으로 한정한다.

| 후보 | 시뮬 접근 | 추가 노출 | 판단 |
|---|---|---|---|
| root:root 0755 | 검색 가능 | 모든 UID에 목록 읽기·검색 | 불필요하게 넓음 |
| root:sim 0750 | 검색 가능 | 전용 그룹에 목록 읽기 | 0755보다 좁으나 읽기 불필요 |
| root:sim 0710 | 검색 가능 | 전용 그룹에 검색만 | 채택 |

`activate`와 일반 배포의 `start_pair`는 시작 전에 보조 그룹을 비우고 실제 전용 UID/GID로
GUARD 검색, 기존 lock의 읽기/쓰기 open(잠금·생성·내용 쓰기 없음), state 검색/쓰기 접근을
확인한다. 접근 실패 또는 검사가 끝나지 않으면 고정된 `guard_access` 이유로 실패하며,
시작·바인딩 변경·setup marker 해제를 하지 않는다. 이 검사는 세션 기동 시험을 대체하지 않는다.

## 이미 준비된 0700의 복구

이 변경을 운영에 적용하거나 서비스를 멈추는 권한은 PR 작성에 포함되지 않는다.
두 모델 검토와 합침 후 조정자가 별도 적용을 지시한다. 검토된 helper 설치에는 기존
`refresh-tools` 절차를 사용하며 `prepare` 재실행과 수동 chmod로 우회하지 않는다.

검토된 코드의 root helper에 `repair-guard-mode --guard-device <approved-device>
--guard-inode <approved-inode>`를 명시한다. 두 핀은 조정자가 독립적인 읽기 조사로 승인하고
적용 직전 다시 확인한다. 기존 CONFIG schema=1은 GUARD의 dev/ino를 기록하지 않고
setup marker의 `setup_identity`만 기록하므로, GUARD 핀을 CONFIG에서 얻었다고 간주하지 않는다.
CONFIG·marker·latch·기존 prepare/validation audit은 변경하지 않는다.

복구는 기존 배포 lock과 세션 lock 모두를 비차단 배타 잠금으로 잡는다. install 및
release-pending fence, session 및 session-pending fence, setup-pending fence가 없어야 한다.
setup marker가 남아 있으면 root 소유의 신뢰 가능한 일반 파일이고 CONFIG의 dev/ino와
일치해야 한다. 성공한 activate가 이미 제거한 marker는 새로 만들지 않는다.
전용 user manager는 inactive/MainPID 0이어야 하고, 전용 UID PID·채워진 cgroup·native/domain
프로세스·해당 DDS 점유가 없어야 한다. 중지나 정리는 이 명령이 수행하지 않는다.

GUARD와 상위 경로의 심볼릭 링크·비신뢰 소유/쓰기권한을 거부하고, GUARD 핀·root 소유·lock/state
기존 권한을 확인한다. 정확히 `root:root 0700`만 같은 디렉터리 FD의 `root:sim 0710`으로 바꾼다.
이미 정확한 `root:sim 0710`이면 파일·audit·디렉터리에 쓰지 않는다. 다른 권한·그룹은 거부한다.

별도 `rootfs-guard-mode-<device>-<inode>.json`(root:root 0400)에 dev/ino, 전후 mode/GID,
시간을 기록한다. mode 숫자는 JSON 정수이며 0700=448, 0710=456이다. 동일 이름 audit을 덮지 않는다.
변경 후 읽기 확인 및 fsync·audit 게시가 실패하면 기존 mode/GID로 복원한다. 복원/내구성을
증명하지 못하면 실패로 보고하고 staging 근거를 보존하므로 자동 재시도하지 않는다.
성공 뒤 staging 정리 잔여는 `cleanup_pending`으로 보고한다.

## API 진단과 한계

simmgr는 fence 거부를 고정 단계와 errno만으로 기록한다. 예외 원문·경로·비밀은 로그나 응답에
넣지 않는다. EACCES/EPERM은 `SIM_UNAVAILABLE` 503, `reason=guard_access`,
`start_not_created=true`로 보낸다. 그 밖 fence 거부는 기존 unknown 의미를 유지하고 로그 단계로
구분한다. 계약에 guard_access를 추가하여 서버의 허용 필드 중계에서 unknown으로 접히지 않는다.

서버는 기존처럼 resources_low만 자동 슬롯 해제 근거로 인정한다. guard_access가 있어도
STARTING 보존·사용자의 정상 정리 흐름을 바꾸지 않는다. 웹은 현재 일반 실패문으로 표시한다.
권한 문제에 대한 별도 안내 문구는 후속 화면 작업으로 고려할 수 있다.
코드 되돌림은 별도 revert PR로 한다. 이미 적용한 디렉터리 권한을 Git revert가 되돌리지는 않는다.
0700으로의 운영 복귀는 서비스를 사용할 수 없게 하므로 별도 조정 지시와 검증이 필요하다.
