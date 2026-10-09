# Windows 실행본

Windows 11 x64용 포터블 패키지는 압축을 풀고 `Tada.exe`를 열면 시작한다. Node, npm, Rust, WSL을 사용자가 설치할 필요가 없다. 기본 브라우저에서 기존 ChatGPT 구독 연결 화면으로 들어간다. 공유 브라우저 작업에는 설치된 Chrome 또는 Edge를 사용한다.

## 기록과 재실행

기본 기록 위치는 Windows 현재 사용자의 `%LOCALAPPDATA%\Tada\conversation`이다. 계정 연결은 옆의 `conversation.chatgpt-private`, 실행 창 정보는 `conversation.app-private`에 둔다. 저장 키는 Windows CurrentUser DPAPI로 보호하며 별도 Tada 암호를 요구하지 않는다. 실행본을 다른 폴더에서 열어도 같은 기본 기록과 현재 실행 중인 비서를 다시 연다. 설치 폴더 안에는 대화와 인증 정보를 저장하지 않는다.

기존 WSL 개발 실행본의 기록을 자동 복사하거나 전환하지 않는다. 다른 Windows 계정이나 컴퓨터로 파일만 복사하는 것은 복구 방법이 아니다. 키가 없거나 손상되면 새 키로 기존 기록을 덮어쓰지 않는다. `--data ABSOLUTE_PATH`는 개발 검증용으로 별도 기록을 선택하며 일반 실행에는 필요 없다.

이 단계는 포터블 실행 경로다. 서명된 설치 프로그램, Windows 로그인 시 자동 시작, 자동 업데이트, 사용자용 백업·복원은 별도 완료 조건이다. Windows 실행 중 브라우저를 닫아도 호스트가 계속 실행되지만 재부팅 후 자동 시작은 아직 제공하지 않는다. Google 연결에는 해당 배포자가 준비한 OAuth 클라이언트가 필요하며, 개발자의 계정·OAuth 비밀값·저장 키는 패키지에 포함하지 않는다. 실제 구독 로그인, 메일 연결, 휴대폰 전달과 출시 자격은 포장 검증으로 대체하지 않는다.

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

## 검증 범위

현재 호스트의 Windows 11에서 개발 도구를 제외한 PATH로 실행, 실제 DPAPI 저장 키 생성·보존, 첫 연결 화면, 재실행·다른 폴더 실행·재시작, 손상/누락/추가 파일 거부, 네이티브 Chrome/Edge 입력을 검증한다. 같은 PC의 검증은 깨끗한 다른 Windows 기기, 실제 사용자 계정 연결, 서명·설치·자동 시작·업데이트·휴대폰 수신의 검증이 아니다. [2026-10-10 검증 기록](windows-portable-verification.json)에 실제 명령 결과, 압축 파일 해시와 남은 범위를 기록했다.
