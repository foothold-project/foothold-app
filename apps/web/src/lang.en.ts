// 영어 화면 글 사전(lang.tsx). 열쇠 = 화면에 그려지는 한국어 글 그대로(앞뒤 빈칸 뺌). 범위 = 머리줄 · 설정(u9) · 관제(u5) · 로봇(u4) · 지도(u7) · 임무(u6) · 기록(u8) 의 앱 글.
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
  '이 시간에는 임무를 만들 때 그 구역을 피하도록 알려 줍니다.': 'When you plan a mission in these hours, you are told to avoid the area.',
  '30 분 ~ 24 시간 · 30 분씩 바꿉니다. 기본 4 시간.': '30 min to 24 h, in 30 min steps. Default 4 h.', '혼잡 시간 추가': 'Add busy hours', '요일': 'Day', '끝': 'End', '넣기': 'Add',
  '이름(예: 점심)': 'Name (e.g. Lunch)', '끝은 시작보다 늦어야 합니다. 자정을 넘으면 두 줄로 나눠 넣으세요.': 'The end must be later than the start. Split hours past midnight into two rows.',
  '이름을 넣으세요(예: 출근 · 점심).': 'Enter a name (e.g. Commute, Lunch).', '30 분 줄이기': 'Shorten by 30 min', '30 분 늘리기': 'Lengthen by 30 min',
  '클립을 서버에 두는 날 수입니다. 지금은 값만 두고 지난 클립을 지우지는 않습니다.': 'Days to keep clips on the server. For now only the value is kept; old clips are not deleted.',
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
  '조이스틱': 'Joystick', '연결됨 · 1 순위': 'Connected · first', '조이스틱을 꽂고 단추를 한 번 누르면 연결됩니다. 조종 화면에서 키보드와 같은 규칙으로 움직입니다.': 'Plug in a joystick and press any button to connect. It drives with the same rules as the keyboard.', '앱에 아직 없음': 'Not in the app yet', '왼쪽 스틱 이동 · 오른쪽 스틱 돌기': 'Left stick moves · right stick turns', '조이스틱 입력을 받는 기능이 앱에 아직 없습니다.': 'The app cannot read a joystick yet.',
  '음성': 'Voice', '누르는 동안 듣기': 'Listens while held', '음성 명령 기능이 앱에 아직 없습니다.': 'The app has no voice commands yet.', '모바일 (폰 터치)': 'Mobile (phone touch)',
  '왼쪽 스틱 이동 · 동작 단추': 'Left stick moves · action buttons', '정지 버튼은 늘 오른쪽 아래에 있습니다.': 'The stop button is always at the bottom right.',

  // 표시(u9_6)
  '화면 밝기 · 언어 · 데모 표시. 여기서만 바꿉니다.': 'Brightness · language · demo label. Changed only here.', '화면 밝기': 'Brightness', '밝게': 'Light', '현장 폰 기본': 'Site phone default',
  '어둡게': 'Dark', '관제 PC 기본': 'Control PC default', '기기 설정 따르기': 'Follow device', '기기 설정대로': 'As the device', '바꾸면 모든 화면에 바로 적용됩니다.': 'Applies to every screen at once.',
  '언어': 'Language', '영어로 바뀌는 곳: 앱 글 전부. 서버가 보낸 글(이름 · 사건 · 알림)은 그대로입니다.': 'In English: all app text. Text sent by the server (names · events · alerts) stays as sent.', '모든 화면 글이 바뀝니다. 숫자와 단위는 그대로입니다.': 'All screen text changes. Numbers and units stay the same.',
  '데모 로봇에 「데모」 표시': 'Show “Demo” on demo robots', '발표할 때는 끄세요. 끄면 표시만 사라지고 데모 로봇은 실제 로봇과 같은 모양으로 보입니다.': 'Turn it off for presentations. Only the label goes away; demo robots look like real ones.',
  '켜고 끄는 값을 저장하는 서버 기능이 아직 없습니다.': 'The server cannot store this switch yet.', '총괄만 바꿀 수 있습니다': 'Only admins can change this', '켬': 'On', '끔': 'Off', '데모': 'Demo', '순찰 중': 'Patrolling',

  // 2 차: 관제(u5) · 로봇(u4) · 지도(u7) · 임무(u6) · 기록(u8) 탭의 앱 글(서버가 준 이름 · 사건 글은 그대로)
  '새 알림': 'New alerts', '연결 끊김': 'Disconnected', '최근': 'Latest', '건만 보입니다 · 기록에서 모두 보기': 'shown · see all in History',
  '타일 보기': 'Tiles', '지도 보기': 'Map', '첫 화면으로': 'Back to start', '전체 보기': 'View all', '임무 중': 'On mission', '충전': 'Charging', '점검': 'Maintenance', '연결 중': 'Connecting', '시뮬 대기': 'Sim waiting',
  '정면 상태로 뒤집기': 'Flip to front view', '데모 표시': 'Demo label', '모두': 'All', '내 로봇': 'My robots', '뒤 2 m': '2 m behind', '연결': 'Link', '담당자': 'Owner', '할 일': 'Tasks',
  '정지 잠금': 'Stop latched', '· 정면 보기': '· front view', '시뮬': 'Sim', '임무 전 · 시뮬 등록': 'Before mission · sim registered', '배터리 해당 없음': 'No battery (sim)', '시뮬 계산': 'Sim calc',
  '카메라 신호 없음 · 로봇 상태를 확인하는 중입니다': 'No camera signal · checking robot status', '연결 전': 'Not connected', '작은 지도': 'Mini map', '점 = 로봇 · 점선 = 시뮬': 'Dot = robot · dashed = sim',
  '경보 ·': 'Alarm ·', '관절 위험': 'Joint danger', '로봇은 스스로 멈추지 않습니다.': 'The robot does not stop by itself.', '로봇 탭에서 보기': 'View in Robots', '최근 경고': 'Recent warnings',
  '기록 탭에서 모두 보기': 'See all in History', '보기': 'View', '범위': 'Scope', '로봇 타일': 'Robot tiles', '작은 지도 · 누르면 지도 보기': 'Mini map · click for map',
  '실시간 3D · 끌어서 돌리기 · 휠 확대': 'Live 3D · drag to rotate · wheel to zoom', '동선 겹쳐 보기': 'Route overlap', '기존 동선': 'Current routes', '대': 'robots', '새 동선': 'New route', '겹치는 곳': 'Overlaps', '현장 3D': 'Site 3D',
  '로봇 추가': 'Add robot', '데모 · 정지 잠금': 'Demo · stop latched', '시뮬 · 정지 잠금': 'Sim · stop latched', '실제 · 연결 끊김': 'Real · disconnected', '바꿀 수 있는 모드 없음': 'No modes to switch', '조종을 시작해야 걷기 모드를 바꿀 수 있습니다.': 'Start driving to change the walking mode.',
  '조종자': 'Driver', '조종': 'Drive', '로봇 설정': 'Robot settings', '끌어서 돌려 보기': 'Drag to rotate', '서 있음': 'Standing', '위치 추정 켜짐': 'Localization on',
  '관절값을 받지 않아 서 있는 모양 그대로': 'No joint values · shown standing', '카메라': 'Camera', '라이다': 'LiDAR', '깊이': 'Depth', '시뮬 시점': 'Sim view', '앞 카메라': 'Front camera', '임무 없음': 'No mission',
  // 조종 단추 글 「조종」 · 「다시 시작」 (폰 조종 · 직결 시뮬 · 실기 · PC 시뮬 탭) · 다시 시작 확인 창(u4_10) · 이어 가기 안내
  '다시 시작': 'Restart', '그 자리에서 일어선 뒤 조종과 동작이 다시 켜집니다. 주변에 사람이 없는지 보세요.': 'The robot stands up where it is, then driving and actions turn back on. Make sure no one is nearby.',
  '먼저 «조종»을 누르세요.': 'Press «Drive» first.', '먼저 «다시 시작»을 누르세요.': 'Press «Restart» first.',
  '이어가려면 «조종»을 누르세요.': 'To resume, press «Drive».', '이어가려면 STOP 을 확인한 뒤 «다시 시작»을 누르세요.': 'To resume, check STOP, then press «Restart».',
  '실행 중에는 수동 조종이 막혀 있습니다. 수동으로 바꾸려면 «일시정지» → 로봇이 멈춘 뒤 «조종» → «다시 시작».': 'Manual driving is blocked while a run is going. To switch to manual, «Pause» → once the robot stops, «Drive» → «Restart».',
  '아직 이어갈 수 없습니다. 로봇의 목표 취소 확인을 기다렸다가 «조종» → «다시 시작» → 손을 뗀 뒤 다시 누르세요.': 'Cannot resume yet. Wait for the robot to confirm the goal was canceled, then «Drive» → «Restart» → let go and press again.',
  '조종 → 다시 시작 뒤 키보드로 움직입니다': 'Press Drive → Restart, then move with the keyboard',
  '조종 시작': 'Start driving', '말하기': 'Talk', '옆걸음': 'Strafe', '화면': 'View', '모드': 'Mode', '앉기': 'Sit', '일어서기': 'Stand up', '엎드리기': 'Lie down', '기지개': 'Stretch', '악수': 'Shake', '하트': 'Heart', '인사': 'Hello',
  '순정 확인 전': 'Stock app not checked', '흐린 단추는 아직 준비 중인 기능입니다(권한 때문인 비활성은 단추 옆에 이유가 따로 나옵니다).': 'Dimmed buttons are not ready yet (buttons disabled by permission show the reason next to them).',
  '나(총괄)': 'Me (Admin)', '이 로봇은 걷기 모드를 바꿀 수 없습니다 (로봇이 보낸 쓸 수 있는 모드 없음).': 'This robot cannot change walking mode (it reported no available modes).', '로봇 보기': 'Robot view',
  '더블클릭하면 크게 봅니다': 'Double-click to enlarge', '비상 정지 · 이 로봇': 'Emergency stop · this robot', '개': 'items', '층': 'Floor',
  '로봇이 현장을 걸으며 스캔한 3D 지도입니다. 층마다 따로 만듭니다.': '3D maps scanned by robots walking the site. One per floor.', '고르기': 'Pick', '관리': 'Manage', '새 지도 만들기': 'New map', '· 층': '· floors',
  '층마다 지도 하나': 'One map per floor', '시험 지형': 'Test terrain', '실측 지도': 'Scanned map', '현장 스캔': 'Site scan', '가져온 지도': 'Imported map', '외부 3D 파일': 'External 3D file', '직접 만든 지형': 'Hand-made terrain',
  '3D 보기 · 미리 보기': '3D view · preview', '시뮬 지형': 'Sim terrain', '금지 구역': 'No-go zones', '지도 열기': 'Open map', '버전 기록': 'Version history', '장소': 'Places', '지도 고르기': 'Pick map', '고르기 · 관리': 'Pick · manage',
  '층 목록': 'Floors', '미리 보기': 'Preview', '3D 미리 보기': '3D preview', '장소 닫기': 'Close place',
  '새 임무': 'New mission', '시작 지점으로 복귀': 'Return to start', '편집': 'Edit', '지점': 'Points', '맞춤': 'Fit', '실제 모습': 'Real view', '장애물 지도': 'Obstacle map', '경로': 'Route', '구역': 'Zones', '길이': 'Length',
  '걷기 + 할 일': 'Walk + tasks', '미리 확인': 'Check', '모두 갈 수 있음': 'All reachable', '일정에 추가': 'Add to schedule', '시작': 'Start', '마감': 'End', '이 시간에 쓸 수 있는 로봇': 'Robots free at this time', '실제': 'Real',
  '비어 있음': 'Free', '걷기 모드': 'Walking mode', '준비 중': 'Not ready', '예상 끝': 'Expected end', '여유': 'Slack', '종료 시 배터리': 'Battery at end', '로봇과 걷기 모드를 고르면 예상이 나옵니다.': 'Pick a robot and a walking mode to see the estimate.',
  '모의 실행': 'Simulate', '오늘 일정': 'Today’s schedule', '대 ·': 'robots ·', '건': 'items', '끝남': 'Done', '진행 중': 'Running', '예정': 'Planned', '작성 중': 'Draft', '배터리 교체': 'Battery swap', '확정': 'Confirmed',
  '임무 목록': 'Missions', '임무 목록 앞 쪽': 'Missions previous page', '임무 목록 다음 쪽': 'Missions next page', '임무 지도': 'Mission map', '지도 확대': 'Zoom map', '축소': 'Zoom out', '확대': 'Zoom in',
  '혼잡 시간은 서버에 값이 없습니다': 'Busy hours: no value from server', '경로 요약': 'Route summary', '시작(시:분)': 'Start (h:m)', '마감(시:분)': 'End (h:m)', '로봇 앞 쪽': 'Robots previous page', '로봇 다음 쪽': 'Robots next page',
  'AME-2 는 아직 일정에 넣을 수 없습니다': 'AME-2 cannot be scheduled yet', '예상': 'Estimate', '다음 일정까지 여유': 'Slack before next slot', '로봇 줄 앞 쪽': 'Robot rows previous', '로봇 줄 다음 쪽': 'Robot rows next',
  '조종권': 'Control', '묶음별 건수는 서버가 주지 않습니다.': 'The server does not give counts per group.', '등급': 'Level', '정보': 'Info', '실제 · 모의 실행': 'Real · simulated',
  '서버에 실제 · 모의 실행 거르기가 없어 모두 보입니다.': 'The server has no real/simulated filter, so all are shown.', '모든 로봇': 'All robots', '클립 있는 것만': 'With clips only', '서버에 클립 거르기가 없습니다.': 'The server has no clip filter.',
  '서버에 값 없음. 클립을 며칠 보관할지 서버가 값을 주면 여기서 바꿉니다.': 'No value from server. Once the server gives a retention period, change it here.', '클립 보관 기간': 'Clip retention period', '클립 보관 기간 ·': 'Clip retention ·', '서버가 보관 일수를 주지 않아 비워 둡니다.': 'The server gives no retention days, so it is left blank.', '서버에 찾기 없음': 'No search on server', '오늘': 'Today', '7 일': '7 days', '30 일': '30 days',
  '지금 장면 저장': 'Save this moment', '내보내기': 'Export', '필터 없음': 'No filter', '클립': 'Clips', '사건': 'Events', '시각': 'Time', '클립 길이': 'Clip length', '정보 단계': 'Info level', '기록만': 'Record only',
  '이어진 상태': 'Ongoing',
  '실기 서버 경유: 앞뒤 · 옆 · 회전 모두 누르고 있으면 2 초에 걸쳐 최고 속도까지, 떼면 0.3 초 안에 멈춥니다.': 'Real robot via server: hold forward/back, sideways or turn and it speeds up to top speed over 2 s; release and it stops within 0.3 s.',
  '임무 중 서버 연결이 끊기고 이 시간이 지나면 로봇을 정지 잠금하고 임무를 멈춥니다. 3 초보다 짧게 둬도 3 초 뒤에 판단합니다.': 'If the server link drops during a mission and this time passes, the robot is stop-latched and the mission stops. Values under 3 s are still judged after 3 s.', '전체': 'All', '모드 전환': 'Mode switches', '서버에 없음': 'Not on server', '연결 · 시스템': 'Link · system', '사용자 작업': 'User actions',
  '기록 거르기': 'History filters', '묶음': 'Group', '서버에 모드 전환 기록이 없습니다': 'The server has no mode-switch records', '찾기': 'Search', '사건 · 로봇 · 메모 찾기': 'Search events · robots · notes', '기간': 'Period',
};

const LV: Record<string, string> = { 위험: 'Danger', 경고: 'Warning', 주의: 'Caution' };
const SIDE: Record<string, string> = { '왼쪽 앞다리': 'Front-left', '오른쪽 앞다리': 'Front-right', '왼쪽 뒷다리': 'Rear-left', '오른쪽 뒷다리': 'Rear-right', '앞 왼': 'Front-left', '앞 오른': 'Front-right', '뒤 왼': 'Rear-left', '뒤 오른': 'Rear-right' };
/** 정지 잠금 까닭(서버 latch_reason 화면 글 · proto/u5 LATCH_WHY) */
const LOCK_WHY: Record<string, string> = { '기동 잠금': 'boot latch', '사람 정지': 'stopped by a person', 넘어짐: 'fall', '연결 끊김': 'link lost', '장치 고장': 'device fault', '권한 확인 늦음': 'permission check late', '조종권 끝남': 'control ended', 기타: 'other', '까닭 미상': 'reason unknown' };
const PART: Record<string, string> = { 고관절: 'hip', 허벅지: 'thigh', 무릎: 'knee', 종아리: 'calf' };
/** 관절 이름(proto/u5 jointName «오른쪽 앞다리 무릎» · go2model jointName «앞 오른 종아리») → «Front-right knee». 모르면 그대로 */
const joint = (s: string) => { const g = /^(.+) (\S+)$/.exec(s); return g && SIDE[g[1]] && PART[g[2]] ? `${SIDE[g[1]]} ${PART[g[2]]}` : s; };

/** 값이 섞인 글(숫자 · 이름 · 시각). 위에서부터 처음 맞는 것 하나 */
export const EN_RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(\d+) 시간(?: (\d+) 분)?$/, (m) => `${m[1]} h${m[2] ? ` ${m[2]} min` : ''}`], [/^(\d+) 분$/, (m) => `${m[1]} min`],   // 중복 점검 기준(orgbusy durText)
  [/^([^·]+) 지우기$/, (m) => `Remove ${m[1]}`],   // 혼잡 막대 지우기 단추
  [/^(.+) 을 일으킬까요\?$/, (m) => `Stand ${m[1]} up?`],   // 다시 시작 확인 창(u4_10 · robotact RESTART_ASK)
  [/^로봇 (\d+) 대 연결$/, (m) => `${m[1]} robots connected`],
  [/^내 로봇 (\d+) 대 연결$/, (m) => `${m[1]} of my robots connected`],
  [/^([^가-힣]+) 정지$/, (m) => `Stop ${m[1]}`],
  [/^([^가-힣]+) [은는] 현장 폰에서만 멈출 수 있습니다$/, (m) => `${m[1]} can only be stopped from the field phone`],
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

  [/^(\d+) 만 m²$/, (m) => `${(+m[1] * 10000).toLocaleString('en-US')} m²`],
  [/^약 (\d+) 분$/, (m) => `about ${m[1]} min`],
  [/^([^가-힣]+) 타일$/, (m) => `${m[1]} tile`],
  [/^([^가-힣]+) · 정지 잠금$/, (m) => `${m[1]} · stop latched`],
  [/^받은 시각 (\d\d:\d\d)$/, (m) => `Received ${m[1]}`], [/^잠금 시작 (\d\d:\d\d)$/, (m) => `Latched ${m[1]}`],
  [/^알림 안 읽음 (\d+)건$/, (m) => `${m[1]} unread alerts`],
  [/^사건 (\d+) 건 이상$/, (m) => `${m[1]}+ events`],
  [/^오늘 · (\d+)월 (\d+)일$/, (m) => `Today · ${m[1]}/${m[2]}`],
  [new RegExp(`^(?:(위험|경고|주의) · )?정지 잠금 · (${Object.keys(LOCK_WHY).join('|')})$`), (m) => `${m[1] ? `${LV[m[1]]} · ` : ''}Stop latched · ${LOCK_WHY[m[2]]}`],
  [/^(위험|경고|주의) · (.+) (\d+) °C$/, (m) => `${LV[m[1]]} · ${joint(m[2])} ${m[3]} °C`],
  [/^(.+) (\d+) °C · (위험|경고|주의)$/, (m) => `${joint(m[1])} ${m[2]} °C · ${LV[m[3]]}`],
  [/^(.+?)이? (\d+) °C 입니다\.$/, (m) => `${joint(m[1])} is ${m[2]} °C.`],
  [/^((?:왼쪽|오른쪽) (?:앞|뒷)다리 \S+|(?:앞|뒤) (?:오른|왼) \S+) (\d+) °C$/, (m) => `${joint(m[1])} ${m[2]} °C`],
  [/^((?:왼쪽|오른쪽) (?:앞|뒷)다리 \S+|(?:앞|뒤) (?:오른|왼) \S+)$/, (m) => joint(m[1])],
];

