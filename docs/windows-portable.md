# Windows 실행본

Windows 11 x64용 패키지는 압축을 풀고 `Tada.exe`를 열면 설치 화면이 나온다. **설치하고 시작하기**를 선택하면 현재 사용자에게 설치하고 시작 메뉴에 Tada를 추가한다. **설치 없이 열기**도 선택할 수 있다. Node, npm, Rust, WSL을 사용자가 설치할 필요가 없다. 기본 브라우저에서 기존 ChatGPT 구독 연결 화면으로 들어간다. 공유 브라우저 작업에는 설치된 Chrome 또는 Edge를 사용한다.

## 기록과 재실행

기본 기록 위치는 Windows 현재 사용자의 `%LOCALAPPDATA%\Tada\conversation`이다. 계정 연결은 옆의 `conversation.chatgpt-private`, 실행 창 정보는 `conversation.app-private`에 둔다. 저장 키는 Windows CurrentUser DPAPI로 보호하며 별도 Tada 암호를 요구하지 않는다. 실행본을 다른 폴더에서 열어도 같은 기본 기록과 현재 실행 중인 비서를 다시 연다. 설치 폴더 안에는 대화와 인증 정보를 저장하지 않는다.

기존 WSL 개발 실행본의 기록을 자동 복사하거나 전환하지 않는다. 다른 Windows 계정이나 컴퓨터로 파일만 복사하는 것은 복구 방법이 아니다. 키가 없거나 손상되면 새 키로 기존 기록을 덮어쓰지 않는다. `--data ABSOLUTE_PATH`는 개발 검증용으로 별도 기록을 선택하며 일반 실행에는 필요 없다.

설치본은 설정의 **자동 실행과 복구**에서 Windows 로그인 시 시작을 등록할 수 있다. 설치만으로 자동 시작을 켜지 않는다. Windows의 시작 앱 설정에서 Tada를 허용해야 하며, 등록 여부는 실제 로그인 실행의 증거가 아니다. 서명된 배포, 자동 다운로드·업데이트와 사용자용 백업·복원은 별도 완료 조건이다. Google 연결에는 해당 배포자가 준비한 OAuth 클라이언트가 필요하며, 개발자의 계정·OAuth 비밀값·저장 키는 패키지에 포함하지 않는다. 실제 구독 로그인, 메일 연결, 휴대폰 전달과 출시 자격은 포장 검증으로 대체하지 않는다.

## 창 닫기와 앱 종료

브라우저 창을 닫아도 먼저 챙겨보기와 휴대폰 연락은 계속 실행된다. Windows 작업 표시줄의 Tada 아이콘을 두 번 누르거나 메뉴의 **Tada 열기**를 선택하면 같은 대화 창을 연다. 두 번째 실행은 기존 창만 열고 별도 아이콘·호스트를 만들지 않는다. Windows의 숨김 자동 시작도 기존 호스트가 있으면 종료하며, 그 뒤에 기다렸다가 사용자가 종료한 앱을 다시 살리지 않는다. Linux 서비스로의 인계는 기존 대기 동작을 유지한다.

**작업을 멈추고 종료**는 새 요청 접수를 즉시 닫고 실행 중 작업을 중단한다. 이미 적용된 변경이나 결과가 불명확한 발신은 원래 상태로 되돌렸다고 기록하지 않는다. 대화·계정·자동 시작 등록·아직 시작하지 않은 요청은 남으며, 대기 요청은 다음 실행에서 이어진다. 발신 전 알림은 대기 상태로 보존하고, 발신 여부를 확정하지 못한 알림은 자동 재전송하지 않는다. 복구 대기 중 종료해도 새 호스트를 시작하지 않는다. 강제 프로세스 트리 종료는 사용하지 않는다.

## 설치와 자동 시작

프로그램은 `%LOCALAPPDATA%\Tada\app`에 설치한다. 시작 메뉴는 고정 진입 파일을 가리키며, 실제 실행 파일은 `versions/<manifest SHA-256>-<복사본 ID>`에 보관한다. 새 실행본을 설치할 때 임시 폴더에서 전체 파일을 검증한 뒤 다음 실행 버전만 원자적으로 선택한다. 이전 버전과 실행 중인 비서는 유지한다. 파일이 손상됐으면 같은 정상 배포본을 다시 설치해 복구한다. 손상된 복사본을 이동·덮어쓰기·실행하지 않고 새 복사본을 검증해 선택하며, 정상 복사본의 반복 설치는 그대로 재사용한다. 설치가 소유한 고정 진입 파일도 다시 설치할 때 복구한다. 현재 실행기는 이전 버전을 계속 사용하므로 설치가 실행 중인 프로세스를 교체했다는 의미는 아니다. 자동 다운로드, 강제 재시작, 데이터 이전·변환은 하지 않는다.

같은 사용자의 HKCU Run에 이 설치만의 항목을 등록한다. 다른 명령이 같은 이름을 사용하면 덮어쓰거나 삭제하지 않는다. 자동 시작을 끄면 다음 로그인 등록만 제거한다. Windows의 시작 앱 승인 설정은 변경하지 않는다. 로그아웃·종료·절전 중에는 일하거나 연락할 수 없다.

실행기는 자신이 실행한 Node 호스트가 비정상 종료했을 때 1초·5초·15초 간격으로 최대 세 번 다시 연다. 정상 종료는 재실행하지 않는다. 일반 실행에서 첫 브라우저 창을 열기 전에 실패하면 숨김 실행으로 돌리지 않고 오류 안내를 보여 준다. 자기 호스트가 열린 뒤의 비정상 종료만 이 복구 대상으로 삼는다. 동의·로그인·모델 선택 중에는 새 설정 화면을 표시하고 아직 없는 기록의 초기화를 유지한다. 비서의 대화 화면이 준비된 뒤부터 숨김 복구로 전환한다. 로그인 시의 숨김 시작은 초기 오류에도 같은 제한 횟수를 적용한다. 기존 요청의 불확실한 결과는 기존 기록의 복구 규칙에 따라 유지하며, 실행기 재시작이 그 요청을 재전송할 권한은 아니다. 실행기 자체가 종료되면 파이프가 닫혀 자기 Node 호스트를 정리한다. 다시 쓰려면 시작 메뉴에서 Tada를 연다. Windows 작업 스케줄러 작업, 일반 브라우저 종료나 프로세스 트리 종료는 사용하지 않는다.

`--install`은 기본 설치의 고급 실행 인자다. `--install-root ABSOLUTE_PATH`는 격리된 네이티브 검증용이며 실제 시작 메뉴 대신 해당 폴더에 테스트 바로가기를 만든다. 사용자 기록과 자동 시작은 생성하지 않는다. 다른 프로그램이 사용 중인 폴더와 링크 경로를 거부한다.

## 파일 확인과 실패 복구

실행 파일에 포함한 manifest와 각 파일의 SHA-256·크기를 검사한다. 빠진 파일, 변경된 파일, 예상하지 않은 추가 파일, 심볼릭 링크와 junction은 실행 전에 거부한다. 파일 손상 안내를 받으면 새 폴더에 전체 압축을 다시 풀어 연다. 기록 폴더는 지우지 않는다. 브라우저를 열 수 없으면 새 호스트와 실행 잠금을 정리하고 안내를 표시한다. 이미 실행 중인 비서의 다시 열기 실패는 기존 호스트를 종료하지 않는다.

이 검사는 손상과 잘못된 패키지를 찾는다. 서명 없는 실행 파일 자체의 게시자 신원을 인증하거나 같은 Windows 사용자의 악의적 파일 교체를 방어한다는 의미는 아니다. `Tada.exe --verify`는 창을 열지 않고 패키지를 검사해 성공이면 0, 실패이면 1을 반환한다.

## 재현 가능한 개발 빌드

빌드에는 Windows x64, 저장소에 고정된 Rust 1.98.1/MSVC 및 Windows SDK, npm CLI, .NET Framework 4 C# 컴파일러가 필요하다. 이는 배포받는 사람의 요구사항이 아니다. 일반 Node 패키지는 lockfile 그대로 `npm ci --omit=dev --ignore-scripts`로 설치한다. 런타임에 사용하는 Ajv와 ajv-formats도 production 의존성이다.

1. 깨끗한 현재 소스에서 네이티브 broker를 빌드한다. `crates`, Cargo 파일뿐 아니라 `packages/contracts/schema`도 필요하다. VC 개발 셸에서 `RUSTFLAGS=-C target-feature=+crt-static`와 제한된 `CARGO_BUILD_JOBS`를 지정하고 `cargo build --release --locked -p tada-agentd --bin tada-read-broker`를 실행한다. 별도 VC 재배포 패키지 없이 실행되는지 PE 의존성을 확인한다.
2. 같은 소스에서 `cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc` 결과를 JSON으로 저장한다. `node scripts/windows-native-notices.mjs METADATA_JSON RUST_TOOLCHAIN_NOTICES OUTPUT_NOTICES`로 의존성별 라이선스와 Rust 배포판의 LICENSE/COPYRIGHT를 모은다. Node와 npm 의존성의 라이선스도 패키지에 함께 보존한다.
3. 공식 [Node 24.21.0 Windows x64 zip](https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip)을 받는다. 빌드 스크립트는 공식 SHA-256 `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`과 다르면 거부한다.
4. `scripts/build-windows-portable.ps1 -NodeArchive NODE_ZIP -Broker BROKER_EXE -NativeNotices NOTICES_DIRECTORY -Output NEW_DIRECTORY -NpmCli NPM_CLI_JS`를 실행한다. 기존 출력 폴더를 덮어쓰지 않는다. 런타임·자산·production 의존성·라이선스를 모으고 manifest를 내장한 `Tada.exe`를 컴파일한 뒤 `--verify`를 실행한다. ZIP에 표현할 수 없는 오래된 파일 날짜는 1980년으로 정규화하고 옆에 `.zip`을 만든다. 실패한 출력은 배포하지 않는다.
5. `node scripts/windows-portable-acceptance.mjs BUNDLE_DIRECTORY REPORT_JSON`를 **Windows에서** 실행한다. 새 임시 기록과 시험 브라우저만 사용한다. 일반 시스템 브라우저에 연결 전 화면을 열고, 실제 계정·모델을 호출하지 않는다. 종료 시 자신이 만든 launcher/호스트만 정리한다. 생성된 ZIP이 같은 manifest의 모든 파일과 실행 파일을 보존하는지도 확인한다.

6. `node scripts/windows-installed-acceptance.mjs BUNDLE_DIRECTORY REPORT_JSON [PREVIOUS_BUNDLE_DIRECTORY]`는 Windows의 새 임시 설치에서 실제 바로가기, 등록·충돌·해제, 기록 재열기, 복구 제한을 확인한다. 이전 실행본 없이 실행하면 파일 손상 재설치와 정상 실행 뒤 충돌 복구도 검사한다. 이전 실행본을 전달하면 그 버전이 실행 중인 채 업데이트하고 같은 대화를 다시 여는 경로를 검사한다. 실제 사용자 설치·시작 메뉴·시작 항목은 변경하지 않는다.
7. `scripts/windows-launcher-recovery.ps1 -Report REPORT_JSON`은 같은 C# 소스와 합성 자식으로 첫 실패 안내창·정상 시작 뒤 충돌·정상 종료·숨김 시작 재시도 한도를 검증한다. 개발 컴파일러가 필요하며 시험 안내창은 자기 프로세스만 찾아 닫는다. 계정·모델·사용자 브라우저를 호출하지 않는다.

8. `scripts/windows-tray-acceptance.ps1 -Report REPORT_JSON -Preview PREVIEW_PNG -Node NODE_EXE`는 실제 Windows Forms 트레이와 제품의 Node 제어 수신기를 연결해 첫 열기·명시 종료·복구 대기 중 종료·재열기 전용 실행을 확인한다. CP949와 UTF-8 BOM 환경을 별도 시험용 콘솔에서 검사하며 실제 계정·메시지 발송은 포함하지 않는다.

## 검증 범위

현재 호스트의 Windows 11에서 개발 도구를 제외한 PATH로 실행, 실제 DPAPI 저장 키 생성·보존, 첫 연결 화면, 재실행·다른 폴더 실행·재시작, 손상/누락/추가 파일 거부, 네이티브 Chrome/Edge 입력을 검증한다. 같은 PC의 검증은 깨끗한 다른 Windows 기기, 실제 사용자 계정 연결, 서명·실제 로그인 후 실행·자동 업데이트·휴대폰 수신의 검증이 아니다. [2026-10-10 검증 기록](windows-portable-verification.json)에 실제 명령 결과, 압축 파일 해시와 남은 범위를 기록했다.

[설치·자동 시작 등록·복구 검증](windows-installed-verification.json)은 별도의 새 임시 설치와 기록에서 수행했다. 실제 Windows 로그인 이후 실행이나 휴대폰 도착을 대신하는 증거는 아니다.

[트레이·명시 종료 검증](windows-tray-verification.json)은 창 다시 열기, 복구 대기 중 종료, 요청·알림·브라우저 입력의 종료 경합과 기록 보존을 구분해 기록한다.
