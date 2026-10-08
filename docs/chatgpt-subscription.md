# 기존 ChatGPT 구독으로 같은 비서 사용하기

연락 호스트의 기본 제공자는 공식 Sign in with ChatGPT 구독 연결이다. 계정 인증, 모델 선택 뒤 기존 `ContactService → ConversationAssistant → 자료 도구`를 사용하며, 기기를 바꾸거나 호스트를 재시작해도 같은 암호화 기록을 연다. 다른 앱의 인증 파일이나 토큰을 사용하지 않는다.

## 실행

```sh
npm ci --ignore-scripts
npm run contact -- --data ./tada-contact-private --init
# 같은 기록으로 다시 시작
npm run contact -- --data ./tada-contact-private
# 기존 계정 재인증
npm run contact -- --data ./tada-contact-private --login
# 실행 중인 호스트를 /quit로 종료한 다음 계정 연결 해제
npm run contact -- --data ./tada-contact-private --logout
```

Windows/WSL에서는 별도 Tada 암호를 만들거나 입력하지 않는다. 로그인된 Windows 계정이 로컬 암호화 키를 보호한다. 대화와 허용된 자료 조회 내용이 OpenAI로 전송되고 선택한 계정의 구독 사용량을 쓴다는 설명에 동의한 뒤, 출력된 공식 로그인 링크를 본인 브라우저에서 연다. 로그인 완료 후 계정별 모델 목록에서 선택한다. 이후 같은 모델을 복원하며, `--model SLUG`로 명시할 수도 있다. API 결제로 자동 전환하지 않는다. ChatGPT에서 이 앱의 크레딧 사용을 허용했다면 그 설정도 적용된다. 구독 포함량만 쓰려면 동의 화면과 사용량 설정에서 크레딧 사용을 허용하지 않는다. 구독 한도와 앱 연결은 [ChatGPT 설정](https://chatgpt.com/settings/usage)에서 관리한다.

자료 확인은 `--broker ABSOLUTE_READ_BROKER --allow-read DIRECTORY`로 허용한 범위만 사용한다. 구독 경로에서는 조회한 내용도 OpenAI로 전송된다. 모델·계정·자료 범위가 기존 저널과 다르면 시작을 거절한다. 현재 버전은 기존 로컬 저널을 구독 계정으로 옮기지 않는다. 원래 설정으로 열거나 새로운 `--data` 경로로 시작해야 한다.

로컬 모델은 명시적으로 선택한다.

```sh
npm run contact -- --provider ollama --data ./tada-local-private --init --model YOUR_INSTALLED_LOCAL_MODEL
```

## 인증과 중단

인증 기록은 기본 `DATA.chatgpt-private` 디렉터리에 둔다. `--chatgpt-profile DIRECTORY`로 별도 위치를 지정할 수 있다. 한 프로필에 한 계정/워크스페이스 등록을 보관한다. 계정 변경은 별도 프로필과 새 저널을 사용한다. 모델 선택은 프로필에 남고 계정·모델의 지문은 연락 기록에 묶인다.

인증 정보와 대화는 자동 생성한 256비트 난수에서 scrypt로 유도한 키와 AES-256-GCM으로 암호화한다. 난수 자체는 Windows CurrentUser DPAPI로 보호한 형태만 인증 프로필의 `storage-key.sqlite`에 저장한다. 이 파일은 인증 프로필·대화와 함께 보존해야 하며, 원래 Windows 사용자 프로필의 복호화 권한도 필요하다. 보호 키가 없거나 열리지 않으면 새 키나 평문 저장으로 대체하지 않는다. 같은 OS 사용자·관리자의 완전한 침해 방어를 의미하지 않는다. Unix의 디렉터리/파일은 소유자 전용이며 심볼릭·하드 링크를 거절한다. 별도 SQLite 독점 잠금으로 동시 호스트의 토큰 갱신 충돌을 막고, 갱신된 토큰·만료·scope는 한 레코드로 교체한다. 개별 대화 취소가 이미 시작한 갱신을 끊지 않으며, 호스트 종료와 로그아웃은 제한된 갱신의 정리를 기다린다. 갱신 중단·서버 5xx 등 미확정 결과는 기록에 남겨 소모됐을 수 있는 토큰을 재전송하지 않고 명시적인 재로그인으로 복구한다. 구독 권한을 처음 거절했다면 검증된 계정 등록과 비활성 상태를 보존하고, 다시 연결할 때만 동의를 요청한다. 로그아웃하면 서버의 세션 폐기를 시도하고 로컬 토큰을 지운다. 서버 폐기가 확인되지 않으면 그 사실과 ChatGPT 설정에서 연결을 해제하는 방법을 표시한다. 계정 등록과 호스트 식별자는 재로그인을 위해 남는다.

모델 요청은 public Responses API에 `store:false`, `stream:true`, `Accept: text/event-stream`으로 전송한다. 응답의 Content-Type이 없으면 SSE 필드 형식과 기존 파서를 통해 본문을 확인하며, 명시된 다른 media type이나 JSON 응답을 대신 받아들이지 않는다. 전체 완료 이벤트와 정상 종료를 확인하기 전에는 답변이나 도구를 채택하지 않는다. 중간 텍스트, 실패·불완전 응답, 취소는 결과가 아니다. 자동 재시도하지 않으며 기존 저널은 미확정 사용량을 unknown으로 남긴다. 비공개 추론 원문과 요약은 답변·기록에 포함하지 않는다. 서버가 반환한 암호화된 추론 항목과 원래 호출 ID·답변 phase는 비공개 이어가기 상태로 보존하고 다음 도구 요청에 재전송한다. 이 상태는 암호화된 연락 checkpoint v2 안에만 저장하며 브라우저·Telegram 답변에는 포함하지 않는다. 기존 v1 checkpoint는 그대로 읽고, 제공자 상태가 생긴 경우에만 v2로 저장한다. 이전 실행 파일은 v2를 읽을 수 없으며 SQL v1–v4 스키마 문자열은 바꾸지 않는다. 암호화된 연속 상태도 기존 문맥 크기 한도에 포함한다.

예약 자료 재확인은 현재 **로컬 전용**이다. 구독 모델에서는 승인 버튼과 서버 승인을 차단하고 예약 실행도 하지 않는다. 현재 대화의 자료 도구, 맡긴 일의 보관, 모델을 부르지 않는 알림은 동일하다. 기존 64회 요청/14 KiB 문맥 한도는 유지한다.

## 확인한 것과 남은 것

가짜 OAuth/JWKS와 로컬 HTTP SSE 서버로 state/PKCE/서명/issuer/audience/nonce/계정/scope, 암호화 복원, 독점 소유권, 갱신과 로그아웃, function tool 왕복, 취소·실패·리다이렉트 거절을 검사한다. 같은 연락 서비스와 실제 SQLite, 선택적 실제 Rust 읽기 브로커를 통한 자료 탐색·인용·두 기기·재시작도 검사한다. 이것은 실제 구독 서버의 모델 응답이나 제품 이해 능력 증명이 아니다.

**2026-10-08 사용자 로그인 후 저장된 연결로 실제 계정 모델 목록 조회에 성공했다. 2026-10-09 두 차례 승인 범위에서 실제 추론 요청 총 네 건을 시도했으며, 마지막 진단은 완료 이벤트와 답변 항목을 확인했지만 앱은 이를 아직 성공으로 수락하지 못했다.** Windows/macOS 새 인증 경로도 미검증이다. CLI 설정은 개발용이며 설치형 온보딩과 장기 기억·일반 실행 도구·16건 제품 수용 평가가 남아 있다. 로컬 공개소스 앱의 공식 연결 자격을 유료/중앙 호스팅 제품의 출시 허가로 해석하지 않는다. 비상업 DevKit 코드를 사용하지 않고 공개 프로토콜과 MIT 라이선스 `jose`를 사용했다.

공식 근거: [등록과 로그인](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [계정과 세션](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [모델과 추론](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [현재 제약](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [도구 namespace](https://developers.openai.com/api/docs/guides/function-calling#defining-namespaces).

2026-10-07 로컬 검증: `npm ci --ignore-scripts --no-audit --no-fund`, `npm run check` **499 통과, 실패/생략 0**. `cargo fmt`, workspace Clippy `-D warnings`, workspace tests와 `tada-agentd --features process-fixtures`가 통과했다. `TADA_TEST_READ_BROKER`를 실제 빌드한 읽기 브로커 경로로 지정한 구독 통합 검사도 통과했다. Chrome 155의 390/1280px 독립 세션에서 구독 표시·창을 닫은 뒤 결과·재접속·기기 폐기 및 기존 로컬 예약 검사를 통과했다. 모델과 OAuth 서버는 합성이며 물리 휴대폰·실제 구독 계정 검증이 아니다.

## 별도 암호 없는 시작

기본 자동 보호는 Windows 및 기본 Windows 경로에 접근 가능한 WSL에서 지원한다. 현재 WSL 환경에서 실제 DPAPI 암복호화, 보호된 키 저장, 같은 대화 기록 재열기를 확인했다. Windows 네이티브 전체 호스트는 미검증이다. WSL에서 사용자 로그인 후 실제 모델 목록 조회는 아래 복구 검증으로 확인했다. 네이티브 Linux/macOS 자동 보호는 아직 구현하지 않았으며 조용히 다른 저장 방식으로 바꾸지 않는다.

이전에 수동 암호로 만든 기록은 기존 명령에 `--ask-passphrase`를 붙여 연다. 수동 모드는 선택 사항이며 기존 16~1024자 조건을 유지한다. 길이·확인 입력이 잘못되면 같은 실행에서 다시 입력할 수 있다. 기존 기록을 자동으로 이전하거나 암호를 바꾸지 않는다. 새로 생성한 자동 보호 기록에는 사용자가 입력할 Tada 암호가 없다.

로컬 모델의 자동 보호 키는 기본 `DATA.key-private/storage-key.sqlite`에 보관한다. 구독은 선택한 인증 프로필과 키를 공유하므로 동일한 프로필을 쓰는 새 대화도 같은 보호 키로 열 수 있다. 키 삭제는 초기화 방법이 아니며 복호화에 필요한 백업도 함께 보존해야 한다.

추가 검증: Node 504건 통과, 합성 CLI에서 암호 질문 없는 기본 로그인·재시작·로그아웃, 수동 기록 보존, 키 분실·손상·동시 초기화 검사. 실제 DPAPI 시험은 로컬 임시 자료만 사용했으며 다른 앱의 자격증명을 읽거나 계정을 연결하지 않았다. `node --experimental-strip-types evals/assistant-v1/contact-key-os-smoke.mjs`로 별도 프로세스 재열기를 포함해 재실행할 수 있다. 실제 PTY에서도 추가 암호 없이 ChatGPT 전송 동의까지 도달하고, 동의를 거절하면 OAuth/추론 없이 끝나는 것을 확인했다.


## 2026-10-08 시작 실패와 재연결 복구

사용자가 데스크톱 앱 전체 종료와 Tada 시작 오류를 보고했다. 기존 데스크톱 로그는 16:30:30 KST에서 끝나고 새 프로세스가 16:30:43에 시작했지만, 조사한 로그·충돌 보고서·커널 기록에서 종료 원인은 확인하지 못했다. Tada가 데스크톱 앱 종료를 일으켰다고 단정할 근거는 없다.

Tada 시작 실패는 별도로 재현했다. 저장된 사용자 연결의 `GET /v1/models`가 HTTP 200, JSON 613,962바이트, 10개 모델을 반환했는데 공용 JSON 리더의 256 KiB 제한이 이를 거절했다. 모델 목록 조회에만 2 MiB 상한을 적용한다. 인증·기타 JSON 응답의 기본 제한은 유지하고 표시용 모델 이름/ID만 선택 화면에 전달한다. 실제 응답 원문이나 토큰은 테스트·문서에 저장하지 않는다. 큰 모델 목록 통과·2 MiB 초과 거절·기본 인증 상한 유지를 합성 자료로 검사한다.

시작 화면은 같은 origin의 localStorage에 로컬 시작 권한을 보관해 서버가 살아 있는 동안 데스크톱/브라우저 재실행 후에도 복원한다. 기존 sessionStorage를 읽는 경로와 저장소 차단 시 메모리 경로는 유지한다. 공급자 자격증명은 브라우저에 저장하지 않는다. 서버 재시작 후 오래된 권한이 거절되면 캐시를 지우고 오류 상태를 표시한다. 새 시작 링크가 우선하며 같은 탭에 다시 열어도 새 권한을 적용한다. 서버의 Host/Origin/소유자 인증은 그대로다.

수정 후 실제 계정 모델 선택 화면을 열었고, 시작 capability가 없는 새 탭에서도 동일 화면 복원을 확인했다. 계정 재로그인·추론·결제 설정 변경은 하지 않았다. 이는 데스크톱 앱 충돌 수정이나 실제 추론 성공의 증거가 아니다.

## 2026-10-09 기존 기록 이전과 스트림 호환성

사용자가 승인한 백업을 거쳐 기존 연락 기록을 v5로 이전하고 같은 대화가 다시 열리는 것을 확인했다. 저장된 구독 계정과 선택 모델은 바꾸지 않았다. 이후 별도 임시 저널에서 합성 Gmail/Calendar 자료로 미팅 준비를 맡기는 요청 한 건을 보냈다. 두 번째는 저널이나 ContactService를 거치지 않고 ChatGPTSubscription에 자료 도구 없는 합성 문장을 직접 보내 전송 형식을 확인했다. 첫 요청은 자료 호출 없이 `CHATGPT_STREAM_REQUIRED`로 실패했다. 두 번째 요청도 같은 오류로 실패했으며, HTTP 200·Content-Type 누락·SSE처럼 보이는 본문 형식만 확인했다. 응답 원문이나 계정 정보는 진단 기록에 저장하지 않았고, 완료 이벤트와 사용량을 확인하지 못했으므로 성공으로 처리하거나 자동 재시도하지 않았다.

로컬 수정은 Content-Type이 정말 없는 응답만 기존 SSE 파서로 전달한다. 이 경로에서는 comment/data/event/id/retry 필드 형식을 확인하고, HTML·JSON에 끼워 넣은 `data:` 줄도 거절한다. 명시된 media type은 정확히 `text/event-stream`이어야 하며, 본문 없음·불완전 종료·늦은 실패·잘못된 도구 호출은 계속 실패한다. 1 MiB·4,096 이벤트 상한과 전체 완료/EOF 검증은 유지한다. `Accept` 추가는 기대 형식을 명시하는 것이며, 헤더 누락의 원인이었다는 증거는 없다. 이 헤더 수정 직후의 추가 승인 시험 결과는 아래와 같다.

Google 프로젝트와 Gmail/Calendar API, 사용자 승인에 따른 OAuth 앱 정책 동의·테스트 모드 데스크톱 클라이언트 등록은 완료했다. 개인 계정의 받은편지함·일정 자료 접근 동의는 아직 완료되지 않았다. 합성 Google 자료로 실행한 전송 시도는 실제 Google 연결이나 개인 받은편지함·일정 접근의 증거가 아니다. 연결 범위와 동의 경계는 [Google 연결 문서](google-connection.md)를 따른다.

## 2026-10-09 완료된 스트림 항목 복원

헤더 수정 후 새로 승인한 두 사용자 턴 중 첫 미팅 준비 요청은 자료 호출 전에 `CHATGPT_INCOMPLETE_TURN`으로 실패했다. 마지막 한 턴은 자료 도구 없는 합성 문장으로 전송 구조만 확인했다. HTTP 200, MIME 누락, 올바른 SSE 12개 이벤트, assistant의 완료된 `response.output_item.done`, `response.completed`와 실제 사용량(입력 19·출력 8)을 확인했다. 그러나 마지막 완료 이벤트의 `output`이 빈 배열이라 기존 파서가 앞서 도착한 답변을 놓쳤다. 원문·계정 정보·reasoning은 진단에 저장하지 않았다. 네 요청 모두 앱 수락 기준에서는 실패이며 자동 재시도하지 않았다.

이 경우에만 완료된 항목을 `output_index` 순서로 복원한다. [공식 스트림 명세](https://developers.openai.com/api/reference/resources/responses/streaming-events)는 `response.output_item.done`에 완료된 항목이 전달됨을 정의한다. 부분 텍스트 delta는 답변이나 도구 실행에 사용하지 않는다. 전체 완료·사용량·EOF, 항목 식별자/순서/중복(함수 호출은 필수 `call_id`와 제공된 경우의 선택적 `id`), 미완료 항목, 도구 namespace와 기존 출력 검증은 유지한다. 완료 응답에도 항목이 있으면 중복 추가하지 않고 앞선 완료 항목과 일치하는지 검사한다. 불일치·중단·잘못된 도구는 실패한다.

이 수정은 관측된 형태를 재현한 합성 회귀 검사로 검증한다. 수정 후 실제 구독 재시험과 Gmail/Calendar를 통한 실제 사용자 작업은 아직 미실행이다. 완료된 단문 응답도 미팅 준비·수정·지속 기록·제품 수용의 증거와 구분한다.

## Native conversation context budget

The subscription provider declares a trusted, fixed 64 KiB budget for the complete serialized request, including tool schemas and encrypted reasoning continuation. The conversation engine captures and validates the declaration (at most 64 KiB) before inference; the contact service forwards it through request metering. Inference admission and tool-result sizing use the same budget. Providers without a declaration, including the local compatibility route, retain the 14,000-byte default. This is Tada's local resource policy, not a claim about a model's advertised context window.

A real connected-account delegation reached `ASSISTANT_CONTEXT_LIMIT` after three completed requests under the old 14,000-byte cap. The original failed run did not retain transient tool contents, so its exact byte composition is unknown. A synthetic native SSE regression reproduces the capacity problem with chained tool calls and encrypted continuation, then verifies source rechecking and conversation recovery across a journal restart under the new bounded budget. No continuation is dropped or rewritten to make a request fit. Existing source, document, request-count, time, grant and journal limits are unchanged. This regression does not by itself qualify live delegation.

The subsequent [bounded connected-account check](qualification-2026-10-07.md#2026-10-09--연결된-google-계정에서-문서-완성) completed one source-backed document and verified restart recovery. Its scope and remaining acceptance gaps are recorded separately from regression results.
