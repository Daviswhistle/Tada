# 연락 호스트의 취소·대기 측정

`scripts/contact-runtime-acceptance.mjs`는 현재 연락 앱의 `ContactStore → ContactService → HTTP` 경로를 측정한다. 실제 사용자 기록·계정이나 원격 모델은 열지 않는다. 임시 암호화 DB와 응답을 세는 합성 모델을 사용한다. 이는 모델 품질 평가나 원문의 전체 출시 기준 통과가 아니다.

```sh
node --experimental-strip-types scripts/contact-runtime-acceptance.mjs cancel cancel.json
node --experimental-strip-types scripts/contact-runtime-acceptance.mjs idle idle.json
```

각 명령은 JSON 보고서를 쓰고 실패 시 종료 코드 1을 반환한다. 실패 표본은 성공 분모에서 조용히 제외하지 않으며 실행 전체를 실패로 기록한다. `idle-smoke`는 10초의 하네스 점검이며 30분 기준의 대체 근거가 아니다. 짧은 측정은 초기 GC 같은 드문 작업에 민감하다.

## 취소와 기기 연결 해제

취소·기기 폐기 × 협조적 중단·늦은 응답의 네 조합을 각 50회 측정한다. 조합별 별도 예열 한 건은 명시적으로 제외한다. 세 개의 새 원장에 표본을 나눠 실제 분당 페어링 20회와 요청 64회 제한을 그대로 지킨다.

실제 페어링 쿠키로 요청을 접수하고 모델 진입을 기다린다. HTTP 취소/로그아웃 요청 직전 단조 시각부터, 저장소의 취소/폐기가 끝나고 실행 중 `AbortSignal`이 중단되는 시각까지를 측정한다. HTTP 응답 시간은 따로 남긴다. 네 조합 각각의 nearest-rank p95가 250ms 이하인지 검사한다.

취소된 원장의 상태와 사유, 취소 API의 변경 확인, 폐기된 쿠키의 후속 접수 401, 실제 추가 모델 dispatch admission 거부, 늦은 답변의 저장 거부와 요청 수를 함께 검사한다. 원격 공급자가 이미 시작한 연산의 종료 시간이나 별도 worker 프로세스의 2초 종료 기준은 측정하지 않는다.

## 정상적인 자동 확인 후 30분 대기

실제 Google 연결 객체를 별도 loopback HTTP 자식 서버에 연결한다. 가짜 토큰만 사용하며 빈 받은편지함과 일정을 제공한다. 실제 HTTP 화면 API로 지속 사용·수시 확인을 켠다. 합성 모델은 현재 업무·메일·일정을 도구로 읽고 정확한 `NO_NEW_SUGGESTION`으로 끝낸다. 예열 작업이 `answered`·`quiet`이고 작업 실패가 없음을 검사한 뒤 측정을 시작한다.

실제 1초 호스트 타이머와 15분 관측 주기를 그대로 둔다. 시계나 SQLite 상태를 앞당기지 않는다. 한국 시간 09–21시의 같은 날짜에 실행하고, 최소 1,800초와 예열 이후 두 번의 정상 Google 관측을 모두 요구한다. 타이머 편차로 두 번째 관측이 아직 완료되지 않았으면 최대 15초만 연장하며 실제 시간을 보고한다.

[Node `process.cpuUsage()`](https://nodejs.org/docs/latest-v24.x/api/process.html#processcpuusagepreviousvalue)의 현재 프로세스 user+system CPU 마이크로초 증가량을 실제 경과 마이크로초로 나누고 100을 곱한다. 논리 코어 한 개를 100%로 삼는다. 1초마다 원시 누적 CPU와 단조 시각을 보존하고, 연속 다섯 표본을 겹치지 않는 창으로 묶어 실제 경과시간으로 나눈다. 마지막 짧은 창도 포함한다. 새 프로토콜의 판정은 이 약 5초 창의 p95가 1% 미만인지이며, 1초 p95·최댓값과 전체 평균도 함께 남긴다. 예열 이후 표본을 버리거나 창 시작점을 옮기지 않는다. 가상 Google HTTP 자식 프로세스는 CPU 분자에서 제외하고 측정 코드 자체의 부하는 포함한다.

모델 호출 증가와 원장 요청 증가가 모두 0이어야 하며, 관측 오류·호스트 오류·작업 실패도 없어야 한다. 기존 1시간 모델 재호출 간격도 작동하므로 이 30분 결과만으로 fingerprint에 의한 반복 억제를 독립 입증하지 않는다. 빈 소스에서 브라우저를 닫은 Node 호스트의 측정이며 Windows tray·브라우저·읽기 중개기 자식 프로세스와 실제 제공자 연산을 합친 전체 앱 CPU가 아니다. 절전·재부팅·오프라인 복구나 물리 휴대폰 전달도 별도 검증 대상이다.

## 측정 방법 변경과 실패 보존

첫 실제 30분 실행에서 Linux의 1초 p95는 기준을 충족했지만 Windows는 충족하지 못했다. Windows의 짧은 CPU 표본은 계단 형태여서 1초 비율만으로 지속 부하를 구분하기 어려웠다. 원문의 출시 기준은 표본 창을 명시하지 않았다. 새 [측정 프로토콜](../evals/runtime/results/2026-10-10-sampling-protocol.json)을 후속 실행 전에 고정하고 원시 누적량을 수집한다. 기존 1초 실패는 별도로 보존하며 5초 합격으로 바꾸지 않는다. 수정 전후 Windows를 같은 하네스로 측정하므로, 관측 코드 변경과 실제 호스트 개선을 구분할 수 있다. 이 방법 변경 자체는 CPU 개선의 증거가 아니다.

## 실제 종료 후 복구

`scripts/contact-crash-acceptance.mjs REPORT.json`은 격리된 연락 호스트 자식 프로세스를 실제로 강제 종료하고 같은 암호화 원장으로 재시작한다. 모델 진입 이후 종료 50회, 별도 loopback 메일 서버가 실제 MIME을 접수했지만 응답하지 않은 경계에서 종료 50회를 검사한다. 후자는 보낸 사본 조회 가능·불가를 각각 25회 나눈다.

이전 답변과 checkpoint 보존, 중단된 요청의 `HOST_RESTARTED` 및 불확실한 요청 원장, 같은 요청 ID 재접수 시 실행 억제, 새 요청의 정상 처리를 확인한다. 메일은 기존 발송 시도·초안·메시지 식별자를 유지하고 재발송을 거부해야 한다. 조회 가능하면 실제 POST 바이트로 만든 보낸 사본과 대조하고, 조회 불가하면 불확실성을 유지한다. 외부 POST가 정확히 한 번인지 확인한다. 실제 제공자 연산이나 실제 수신함 전달, 전체 전이 1,000회 출시 시험을 대신하지 않는다.

기존 1초 판정 하네스의 실행 바이트는 [`one-second-harness.mjs.txt`](../evals/runtime/one-second-harness.mjs.txt)에 보존한다. 재현하려면 이 파일을 저장소 `scripts/` 아래 `.mjs` 파일로 복사해 실행한다. 30분 측정에 사용한 v2 실행 바이트는 [별도 파일](../evals/runtime/five-second-measured-harness.mjs.txt)에 보존한다. 이후 코드 검수에서 시험용 자식이 응답 전에 종료하면 IPC 대기가 끝나지 않는 문제가 발견돼 현재 하네스에 종료·오류·제한 시간과 안전한 정리를 추가했다. 이 보완 뒤 30분을 재측정했다고 주장하지 않는다. 아래 측정은 기록된 하네스 해시와 동결된 제품 코드의 결과다. 개발 중 하네스 오류와 범위를 강화한 재실행은 [별도 기록](../evals/runtime/results/2026-10-10-harness-development.json)에 남긴다.

## 2026-10-10 실제 결과

제품 변경 커밋은 `92deb6f`이며 [소스 해시와 검증 범위](../evals/runtime/results/2026-10-10-runtime-source.json)를 남겼다. 기준 버전은 `51fd56c`다. CPU는 논리 코어 한 개를 100%로 한다.

| 동일한 1초 판정 하네스 | 실제 단조 경과 | 1초 p95 | 전체 평균 | 판정 |
| --- | ---: | ---: | ---: | --- |
| [Windows 기준 버전](../evals/runtime/results/2026-10-10-windows-idle-one-second-control.json) | 1,801.28초 | 1.5937% | 0.3149% | 실패 |
| [Windows 수정본](../evals/runtime/results/2026-10-10-windows-idle-one-second-final.json) | 1,800.50초 | 0% | 0.0738% | 통과 |
| [Linux/WSL 수정본](../evals/runtime/results/2026-10-10-linux-idle-one-second-final.json) | 1,800.79초 | 0.1481% | 0.0559% | 통과 |

사전에 정한 5초 프로토콜은 별도의 30분 실행이다. 1초 값을 같은 실행에서 함께 남겼다.

| 원시 누적 CPU를 수집한 실행 | 실제 단조 경과 | 5초 p95 | 1초 p95 | 1초 최대 | 전체 평균 |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Windows 기준 버전](../evals/runtime/results/2026-10-10-windows-baseline-idle-five-second.json) | 1,801.34초 | 0.9354% | 1.5934% | 9.3334% | 0.3582% |
| [Windows 수정본](../evals/runtime/results/2026-10-10-windows-candidate-idle-five-second.json) | 1,801.62초 | 0.3182% | 0% | 7.8481% | 0.0668% |
| [Linux/WSL 수정본](../evals/runtime/results/2026-10-10-linux-candidate-idle-five-second.json) | 1,800.23초 | 0.0875% | 0.1345% | 2.8522% | 0.0516% |

5초 기준은 수정 전후 모두 통과했다. 이를 기준 버전의 1초 실패 해소로 계산하지 않는다. 수정본은 별도 1초 측정에서도 통과했으며, 같은 하네스를 사용한 Windows 비교에서 평균 부하가 줄었다. 한 기기의 반복 측정이고 시스템 전체 부하를 통제한 여러 기기 성능 연구가 아니다. 원시 누적량으로 1초 비율·5초 창·nearest-rank p95·전체 평균을 독립 재계산했고 보고서와 일치했다.

위 여섯 실행 모두 실제 Google 관측 두 번을 마쳤고, 예열 이후 모델 호출과 원장 요청 증가는 0이었다. 정수 0인 Windows p95는 95% 지점의 측정 카운터가 0이었다는 뜻이며 CPU가 전혀 사용되지 않았다는 뜻은 아니다.

취소·기기 해제는 [Linux](../evals/runtime/results/2026-10-10-linux-cancel-final.json)와 [Windows](../evals/runtime/results/2026-10-10-windows-cancel-final.json)에서 각각 200회 측정했다. 네 조합의 p95 최댓값은 각각 10.962ms·7.246ms로 250ms 기준을 충족했다. 각 조합의 예열 1건은 별도다.

실제 강제 종료는 [Linux](../evals/runtime/results/2026-10-10-linux-crash-final.json)와 [Windows](../evals/runtime/results/2026-10-10-windows-crash-final.json)에서 각각 100회 통과했다. 모든 표본에 살아 있는 자식의 종료 요청 성공과 `SIGKILL` 종료 결과를 확인했다. 메일 시험은 각 환경에서 보낸 사본 조회 가능 25회·불가 25회이며, 각 표본의 발송 POST는 한 번이었다. 보낸 사본은 종료되지 않은 부모 시험 서버의 메모리에 보존되므로 시스템 전원 손실이나 원격 서버 저장 내구성을 검증하지 않는다.

제품 코드의 전체 생성물·타입·Node 검사 1,475개가 생략 없이 통과했고, 같은 소스의 네이티브 Windows 관련 검사 119개가 통과했다. 독립 코드 검수는 제품 변경에서 수정할 회귀를 찾지 못했다. 검수자가 실행한 관련 검사 326개 통과·5개 생략은 주 실행의 전체 무생략 결과와 구분한다. Rust·공개 스키마·의존성이 바뀌지 않아 앞 단계의 fmt/clippy/workspace/process-fixture 및 npm ci 근거를 재사용했다.

Windows build20은 제품 런타임 79개 파일의 경로·바이트가 측정 소스와 같았다. [새 설치·복구 11개](../evals/runtime/results/2026-10-10-windows-installed20.json), [19→20 업데이트 8개](../evals/runtime/results/2026-10-10-windows-upgrade19-20.json), [실제 Chrome·Edge 포함 portable 검사 8개](../evals/runtime/results/2026-10-10-windows-portable20.json)가 통과했다. 실제 사용자 계정 이전, 물리 휴대폰 수신, 서명·공개 배포 수락은 포함하지 않는다.

IPC 보완은 Linux·Windows에서 각각 실제 자식 프로세스의 준비 전 종료, 응답 전 종료, 무응답 시간 초과, 정리 무응답 후 강제 종료, 실행 파일 없음의 다섯 검사를 통과했다. 보완 뒤 [Linux 10초 진단](../evals/runtime/results/2026-10-10-linux-ipc-smoke.json)과 [Windows 10초 진단](../evals/runtime/results/2026-10-10-windows-ipc-smoke.json)은 CPU p95 기준으로 실패했고, 실패 JSON과 종료 코드 1을 남기며 정상 정리됐다. 각각 5초 창 p95는 1.1545%·1.8900%다. 짧은 진단 실패를 30분 성능 통과로 바꾸거나 제외하지 않는다.

강제 종료 하네스의 프로세스 실행·IPC 오류도 실패 JSON과 정리 경로로 전달하도록 보완했다. 실행 파일 없음, IPC 오류 콜백, 자식 error 이벤트, 잘못된 발송 MIME의 실제 프로세스 검사 네 가지를 Linux·Windows에서 각각 통과했다. 보완 전 원시 측정은 그대로 보존하고, 보완 후 [Linux](../evals/runtime/results/2026-10-10-linux-crash-amended.json)·[Windows](../evals/runtime/results/2026-10-10-windows-crash-amended.json) 정상 종료·복구 100회씩도 통과했다. 오류 검사마다 실패 JSON·임시 원장 삭제·기록한 자식 PID의 종료까지 확인한다. 제품 런타임의 바이트는 변경하지 않았다.
