// 영어 화면 글 사전(lang.tsx). 열쇠 = 화면에 그려지는 한국어 글 그대로(앞뒤 빈칸 뺌). 1 차 범위 = 머리줄 · 설정(시안 u9) · 정지 글.
// 숫자와 단위는 그대로 둔다(시안 u9_6 「숫자와 단위는 그대로입니다」). 사전에 없는 글은 한국어 그대로(서버 값 · 이름).
export const EN: Record<string, string> = {
  // 머리줄 · 메뉴
  '관제': 'Control', '로봇': 'Robots', '지도': 'Maps', '임무': 'Missions', '기록': 'History', '설정': 'Settings', '결재': 'Approvals',
  '주 메뉴': 'Main menu', '연결된 로봇 없음': 'No robots connected', '서버 정상': 'Server OK', '서버 연결 중': 'Connecting to server', '서버 연결 거부': 'Server refused', '서버 연결 끊김': 'Server disconnected',
  '알림': 'Alerts', '알림 목록': 'Alert list', '모두 읽음': 'Mark all read', '다시 시도': 'Try again', '나': 'Me', '총괄': 'Admin', '운영자': 'Operator', '내 차림': 'My menu',
  '모두 정지': 'Stop all', '비상 정지': 'Emergency stop', '정지': 'Stop', '로그아웃': 'Log out', '밝음': 'Light', '어두움': 'Dark', '기기 설정': 'Device', '기기 설정 따름': 'Follow device',
  '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.': 'Could not reach the server. Check the network and try again.',
  '알림을 받지 못했습니다. 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.': 'Could not load alerts. Could not reach the server. Check the network and try again.',
  '요약을 받지 못했습니다. 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.': 'Could not load the summary. Could not reach the server. Check the network and try again.',
  '정지됨': 'Stopped', '로봇이 멈췄습니다': 'The robot has stopped',

  // 설정 왼쪽 메뉴
  '계정': 'Account', '현장': 'Site', '사용자와 권한': 'Users & roles', '총괄만': 'Admin only', '현장 연결': 'Site network', '현장 혼잡 시간': 'Busy hours',
  '로봇과 안전': 'Robots & safety', '안전': 'Safety', '기록과 클립': 'Records & clips', '화면과 조작': 'Display & controls', '조작': 'Controls', '표시': 'Display',
  '데모 로봇 표시': 'Demo robot label', '기기': 'Device', '시스템': 'System', '이 묶음은 시안 그림이 아직 없어 지금 앱 판으로 보입니다.': 'This group has no design yet and shows the current app version.',

  // 계정(u9_1) · 비밀번호(u9_2)
  '내 계정과 비밀번호. 로그인한 기기 목록은 총괄만 볼 수 있습니다.': 'Your account and password. Only admins can see signed-in devices.',
  '내 계정': 'My account', '아이디': 'ID', '서버에 값 없음': 'No value from server', '· 마지막 로그인': '· Last login', '비밀번호': 'Password', '비밀번호 바꾸기': 'Change password',
  '이름 표시': 'Display name', '다른 사람 화면에는 「': 'Others see you as “', '」 로 보입니다': '”', '이름 바꾸기': 'Rename', '이 PC 에서만 로그아웃됩니다': 'Logs out of this PC only',
  '최근 활동': 'Recent activity', '최근 활동이 없습니다.': 'No recent activity.', '로그인 기기': 'Signed-in devices', '로그인한 기기가 없습니다.': 'No signed-in devices.', '끊기': 'Disconnect',
  '끊은 기기는 다시 로그인해야 쓸 수 있습니다. 조종 중인 기기를 끊으면 그 로봇은 그 자리에 멈춥니다.': 'A disconnected device must log in again. Disconnecting a device that is driving stops that robot where it is.',
  '로그인': 'Login', '비밀번호 바꿈': 'Password changed', '모든 기기에서 로그아웃됨': 'Logged out on all devices', '폰': 'Phone', '지금': 'Now', '앞 쪽': 'Previous page', '다음 쪽': 'Next page',
  '내 이름': 'My name', '이름 저장': 'Save name', '이름을 바꿨습니다.': 'Name changed.', '이름을 입력하세요.': 'Enter a name.', '취소': 'Cancel', '닫기': 'Close', '바꾸기': 'Change', '만들기': 'Create',
  '지금 비밀번호': 'Current password', '새 비밀번호': 'New password', '새 비밀번호 다시': 'New password again', '지금 비밀번호를 입력하세요.': 'Enter your current password.',
  '새 비밀번호는 8 자 이상이어야 합니다.': 'The new password must be at least 8 characters.', '새 비밀번호 두 칸이 서로 다릅니다.': 'The two new passwords do not match.',
  '8 자 이상 입력하세요. 스페이스는 정지 키라서 쓸 수 없습니다.': 'Use at least 8 characters. Space is the stop key and cannot be used.',
  '바꾸면 모든 기기에서 로그아웃됩니다. 새 비밀번호로 다시 들어오세요.': 'Changing it logs you out on all devices. Sign in again with the new password.',

  // 사용자와 권한(u9_3)
  '계정은 총괄과 운영자 두 가지입니다. 권한은 총괄이 가장 넓습니다.': 'There are two account types, admin and operator. Admins can do the most.',
  '사용자': 'Users', '사용자 추가': 'Add user', '이름': 'Name', '역할': 'Role', '담당 로봇': 'Robots', '마지막 접속': 'Last seen', '없음': 'None', '잠김': 'Locked', '임시 비밀번호': 'Temporary password',
  '임시 비밀번호는 12 자로 만들어 한 번만 보여 줍니다. 받은 사람은 처음 로그인할 때 바꿔야 합니다.': 'Temporary passwords are 12 characters and shown once. The user must change it at first login.',
  '임시 비밀번호를 다시 만드는 서버 기능이 아직 없습니다. 새 계정을 만들 때만 임시 비밀번호를 줍니다.': 'The server cannot reissue temporary passwords yet. One is given only when an account is created.',
  '사용자 고치기': 'Edit user', '아이디와 이름을 입력하세요.': 'Enter an ID and a name.', '권한': 'Permissions', '할 수 있는 일': 'Allowed actions', '로봇 연결': 'Connect robots', '조종 · 동작': 'Drive · actions',
  '정지 (어느 로봇이든)': 'Stop (any robot)', '임무 만들기 · 모의 실행': 'Create missions · simulate', '지도 만들기': 'Create maps', '로그인 기기 보기 · 끊기': 'View · disconnect devices', '데모 로봇 표시 끄기': 'Hide demo label',
  '총괄은 운영자가 하는 일을 모두 합니다. 남이 담당한 로봇의 조종권은 뺏지 않고 요청합니다.': 'Admins can do everything operators do. Control of a robot someone else owns is requested, not taken.',
  '바꾼 기록': 'Change log', '바꾼 기록이 없습니다.': 'No changes yet.', '바뀐 값이 없습니다.': 'Nothing changed.',

  // 현장 연결(u9_4)
  '저장된 현장 네트워크와 서버. 연결 상태는 모든 탭 위쪽 줄에도 늘 보입니다.': 'Saved site networks and server. Connection status is always shown in the top bar.',
  '현장 네트워크 목록': 'Site networks', '네트워크 추가': 'Add network', '저장된 현장 네트워크: 서버에 값 없음. 현장 네트워크를 저장하는 서버 기능이 아직 없습니다.': 'Saved site networks: no value from server. The server cannot store site networks yet.',
  '현장 네트워크를 저장하는 서버 기능이 아직 없어 추가할 수 없습니다.': 'The server cannot store site networks yet, so none can be added.',
  '로봇 한 대의 연결 상태와 바꾸기는 로봇 탭에서 봅니다.': 'Each robot’s connection is shown and changed in the Robots tab.', '서버': 'Server', '정상': 'OK', '연결 안 됨': 'Not connected',
  '로봇과 앱이 연결됨': 'Robots and app connected', 'Wi-Fi 추가 로그인 필요 없음': 'No Wi-Fi sign-in needed', '서버까지 연결됨': 'Server reachable', '현장 확인': 'Site check',
  '현장 담당자 승인': 'Site approval', '로봇을 처음 연결할 때 현장 담당자가 승인': 'Site staff approve the first robot connection',
  '. 켜고 끄는 값은 서버 권한 결정을 기다립니다. 정해지면 켤 때 로봇 옆 사람이 폰에서 승인해야 연결됩니다.': '. This switch waits for a server permission decision. Once set, someone next to the robot approves on a phone.',
  '끊겼을 때': 'When disconnected', '점검에서 문제가 하나라도 생기면 이유와 해결 버튼을 보여 줍니다.': 'If any check fails, the reason and a fix button are shown.',
  '. 망 · 기기 간 차단 · Wi-Fi 추가 로그인을 점검하는 서버 기능이 아직 없어, 끊긴 까닭과 해결 단추를 보일 수 없습니다.': '. The server cannot check the network, device isolation or Wi-Fi sign-in yet, so no reason or fix can be shown.',

  // 혼잡 시간(u9_8)
  '사람이 많은 시간입니다. 총괄이 정하며 바꾼 기록이 남습니다.': 'Hours when many people are on site. Set by admins, with a change log.',
  '혼잡 시간': 'Busy hours', '시간 추가': 'Add hours', '월': 'Mon', '화': 'Tue', '수': 'Wed', '목': 'Thu', '금': 'Fri', '토': 'Sat', '일': 'Sun',
  '혼잡 시간: 서버에 값 없음. 사람이 많은 시간을 저장하는 서버 기능이 아직 없어 막대를 그리지 않습니다.': 'Busy hours: no value from server. The server cannot store busy hours yet, so no bars are drawn.',
  '혼잡 시간을 저장하는 서버 기능이 아직 없어 추가할 수 없습니다.': 'The server cannot store busy hours yet, so none can be added.',
  '중복 점검 기준': 'Duplicate inspection window', '같은 곳을 이 시간 안에 다시 점검하면 겹친다고 알려 줍니다': 'Warns when the same spot is inspected again within this time',
  '기준 시간을 저장하는 서버 기능이 아직 없습니다(시안 기본 4 시간).': 'The server cannot store this window yet (design default 4 h).',

  // 알림(u9_5)
  '언제 알릴지 정합니다. 단계마다 숫자와 글을 함께 보여 줍니다.': 'Choose when to alert. Each level shows a number and a label.',
  '관절 온도': 'Joint temperature', '최고 관절 온도 기준': 'Based on the hottest joint', '보통': 'Normal', '주의': 'Caution', '경고': 'Warning', '위험': 'Danger',
  '모터 보호 기능이 작동하면 온도와 상관없이 위험': 'Motor protection triggered means Danger at any temperature', '알림은 로봇을 세우지 않고, 멈출지 물어봅니다.': 'Alerts never stop the robot. They ask whether to stop.',
  '이상 감지': 'Anomalies', '급상승': 'Sudden rise', '2 분 안에 10 °C 넘게 오르면': 'Up more than 10 °C within 2 min', '한 관절만 뜨거움': 'One joint hot',
  '같은 다리 다른 관절보다 15 °C 높으면': '15 °C above other joints on the same leg', '배터리': 'Battery', '주의 · 반복 알림': 'Caution · repeats', '위험 · 반복 알림': 'Danger · repeats',
  '받는 곳': 'Recipients', 'PC 위쪽 알림 종': 'PC top-bar bell', '모든 알림': 'All alerts', '담당자 폰': 'Owner’s phone', '주의 등급 이상': 'Caution and above', '소리': 'Sound', '경고 · 위험': 'Warning · Danger',
  '이렇게 알립니다': 'How alerts look', '단계와 숫자를 함께 보여 주고, 정지는 권하기만 합니다': 'Level and number together. Stopping is only suggested',
  '오른쪽 앞다리 무릎': 'Front-right knee', '왼쪽 뒷다리 무릎': 'Rear-left knee', '계속 걷는 중': 'Still walking', '멈춤': 'Stopped', '같은 다리 다른 관절보다 16 °C 높음': '16 °C above other joints on the same leg', '반복 알림 중': 'Repeating',
  '켜고 끄는 값을 저장하는 서버 기능이 아직 없어 시안 기본값(켬)으로 보입니다.': 'The server cannot store this switch yet, so the design default (on) is shown.',

  // 조작(u9_7)
  '키보드 · 조이스틱 · 음성 · 폰 터치. 규칙은 PC 와 폰이 같습니다.': 'Keyboard · joystick · voice · phone touch. PC and phone follow the same rules.',
  '키보드': 'Keyboard', '앞으로': 'Forward', '누르는 동안 걷습니다': 'Walks while held', '돌기': 'Turn', '그 자리에서 왼쪽 · 오른쪽': 'Left · right in place', '뒤로': 'Back',
  '아직 막혀 있습니다 · 누르면 까닭 한 줄': 'Blocked for now · pressing shows why', '방향키와 같음': 'Same as arrow keys', 'W 앞 · A 왼쪽 · D 오른쪽 · S 뒤 (막힘)': 'W forward · A left · D right · S back (blocked)',
  '어느 화면에서나 · 이동 입력보다 먼저': 'On any screen · before any move input', '멈춰 있을 때만 · 한 번 확인': 'Only while stopped · confirm once', '입력이 겹치면': 'When inputs overlap',
  '정지가 이동보다 우선합니다. 리모컨이 앱보다 우선합니다. 한 로봇은 한 번에 입력 하나만 받습니다.': 'Stop beats movement. The remote beats the app. A robot takes one input at a time.',
  '조이스틱': 'Joystick', '앱에 아직 없음': 'Not in the app yet', '왼쪽 스틱 이동 · 오른쪽 스틱 돌기': 'Left stick moves · right stick turns', '조이스틱 입력을 받는 기능이 앱에 아직 없습니다.': 'The app cannot read a joystick yet.',
  '음성': 'Voice', '누르는 동안 듣기': 'Listens while held', '음성 명령 기능이 앱에 아직 없습니다.': 'The app has no voice commands yet.', '모바일 (폰 터치)': 'Mobile (phone touch)',
  '왼쪽 스틱 이동 · 동작 단추': 'Left stick moves · action buttons', '정지 버튼은 늘 오른쪽 아래에 있습니다.': 'The stop button is always at the bottom right.',

  // 표시(u9_6)
  '화면 밝기 · 언어 · 데모 표시. 여기서만 바꿉니다.': 'Brightness · language · demo label. Changed only here.', '화면 밝기': 'Brightness', '밝게': 'Light', '현장 폰 기본': 'Site phone default',
  '어둡게': 'Dark', '관제 PC 기본': 'Control PC default', '기기 설정 따르기': 'Follow device', '기기 설정대로': 'As the device', '바꾸면 모든 화면에 바로 적용됩니다.': 'Applies to every screen at once.',
  '언어': 'Language', '지금 영어로 바뀌는 곳: 머리줄 · 설정. 다른 탭은 차례로 늘립니다.': 'In English now: top bar · Settings. Other tabs will follow.', '모든 화면 글이 바뀝니다. 숫자와 단위는 그대로입니다.': 'All screen text changes. Numbers and units stay the same.',
  '데모 로봇에 「데모」 표시': 'Show “Demo” on demo robots', '발표할 때는 끄세요. 끄면 표시만 사라지고 데모 로봇은 실제 로봇과 같은 모양으로 보입니다.': 'Turn it off for presentations. Only the label goes away; demo robots look like real ones.',
  '켜고 끄는 값을 저장하는 서버 기능이 아직 없습니다.': 'The server cannot store this switch yet.', '총괄만 바꿀 수 있습니다': 'Only admins can change this', '켬': 'On', '끔': 'Off', '데모': 'Demo', '순찰 중': 'Patrolling',
};

/** 값이 섞인 글(숫자 · 이름 · 시각). 위에서부터 처음 맞는 것 하나 */
export const EN_RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^로봇 (\d+) 대 연결$/, (m) => `${m[1]} robots connected`],
  [/^내 로봇 (\d+) 대 연결$/, (m) => `${m[1]} of my robots connected`],
  [/^([^가-힣]+) 정지$/, (m) => `Stop ${m[1]}`],
  [/^([^가-힣]+) 외 (\d+) 대 조종 중$/, (m) => `Driving ${m[1]} +${m[2]}`],
  [/^([^가-힣]+) 조종 중$/, (m) => `Driving ${m[1]}`],
  [/^결재 (\d*)$/, (m) => `Approvals ${m[1]}`.trim()],
  [/^결재 대기 (\d*)$/, (m) => `Pending approvals ${m[1]}`.trim()],
  [/^오늘 (\d\d:\d\d)$/, (m) => `Today ${m[1]}`],
  [/^어제 (\d\d:\d\d)$/, (m) => `Yesterday ${m[1]}`],
  [/^어제$/, () => 'Yesterday'],
  [/^(\d+\/\d+) 에 바꿈$/, (m) => `Changed ${m[1]}`],
  [/^마지막 점검 (.+)$/, (m) => `Last checked ${m[1].replace(/^오늘 /, 'Today ').replace(/^어제/, 'Yesterday')}`],
  [/^폰 · (.*)$/, (m) => `Phone · ${m[1]}`],
  [/^(.*)\(총괄\)$/, (m) => `${m[1]} (Admin)`],
  [/^(.*)\(운영자\)$/, (m) => `${m[1]} (Operator)`],
  [/^(.+) 고치기$/, (m) => `Edit ${m[1]}`],
  [/^화면 밝기 (.+)$/, (m) => `Brightness ${EN[m[1]] ?? m[1]}`],
  [/^화면 밝기: (.+) · 누르면 (.+)$/, (m) => `Brightness: ${EN[m[1]] ?? m[1]} · next ${EN[m[2]] ?? m[2]}`],
  [/^할 일 (\d+) \/ (\d+)$/, (m) => `Tasks ${m[1]} / ${m[2]}`],
];

