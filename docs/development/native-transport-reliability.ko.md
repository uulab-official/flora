# 네이티브 Runner 통신 안정성

## 적용 범위
`packages/ota-runner/src/native-client.ts`의 실제 네이티브 관리 API 통신을 개선했습니다. 별도 로컬 콘솔 스크립트를 대체하는 기능이 아닙니다. pending, claim, heartbeat, credentials, complete, fail, presence가 같은 제한 시간과 응답 처리 계층을 사용합니다. 서버 라우트·본문 형식·기본 20초 제한은 유지합니다.

## 수정한 원인
기준 HEAD `6873fa27e19e81e60bb32cf7d2238a2e897a0331`의 Foundation Linux job `125158203105`에서 기존 `native heartbeat HTTP transport observes cancellation and remaining lease deadline`가 실패했습니다. `NATIVE_LEASE_EXPIRED` 대신 `NATIVE_TRANSPORT_UNAVAILABLE`이 반환됐습니다. 타이머 종료 후 `Date.now()`로 다시 만료 원인을 추정하는 구조였습니다.

새 요청은 처음 정한 제한과 만료 원인을 보존합니다. 원래 lease가 먼저 끝나는 경우와 요청 자체의 20초 제한을 구분합니다. 경과 시간은 단조 시계를 사용하고, 성공을 받아들이기 전에 원래 lease의 벽시계 만료도 확인합니다. 시계가 뒤로 이동해도 이미 정한 요청 예산이 늘어나지 않습니다.

## 기능
- fetch 응답 헤더와 전체 본문에 **하나의** 요청 예산을 적용합니다. 청크가 도착해도 시간이 리셋되지 않습니다.
- AbortSignal을 무시하는 비동기 fetch/읽기도 호출자에게 무한 대기를 요구하지 않습니다. 늦게 오는 응답 본문은 폐기하고 늦은 거절도 처리합니다.
- 이미 확인한 HTTP 거부 상태를 본문 오류 때문에 일시적 통신 오류로 바꾸지 않습니다. 409의 정확한 `{ "error": "BUSY" }`만 기존 backpressure 코드로 해석합니다. 그 밖의 409는 보수적으로 일반 거부로 처리합니다.
- 성공 본문은 최대 4MiB, 409 오류 본문은 최대 16KiB입니다. 잘못된 UTF-8·JSON·잘못된 top-level 응답·스코프 변경을 거부합니다. 많은 작은 청크도 보관 메모리가 바이트 한도에 따라 제한됩니다.
- 원점·자격 증명·앱·플랫폼·fetch 함수는 생성 시 고정합니다. 대기 중 호출자가 설정 객체를 수정해도 다른 자격 증명으로 바뀌지 않습니다. lease는 own data 속성만 복사합니다.
- 모든 메서드에 선택적 AbortSignal을 추가했습니다. 기존 인자 형태와 구현체는 호환됩니다. 하트비트 외 단계의 상위 controller가 신호를 넘기지 않는 기존 호출도 기본 요청/lease 제한은 적용받습니다. 상위 호출부 전체의 종료 신호 전파까지 완료했다고 주장하지 않습니다.
- 네트워크 오류·취소 이유·서버 본문의 원문을 오류 메시지에 포함하지 않습니다. HTTP status와 기존 고정 코드만 노출합니다.
- transport에서 claim/complete/fail 등 쓰기 요청을 **자동 재전송하지 않습니다**. 기존 상위 heartbeat 재시도 정책은 바꾸지 않습니다.

## 사용
```ts
const controller = new AbortController();
const grant = await nativeClient.credentials(lease, controller.signal);
```
선택적 signal 위치: `pending(signal)`, `claim(jobId, signal)`, `heartbeat(lease, signal)`, `credentials(lease, signal)`, `complete(lease, artifact, signal)`, `fail(lease, code, signal)`, `presence(signal)`.

취소·타임아웃은 **서버 변경의 롤백 증거가 아닙니다**. 특히 완료 요청의 응답이 끊기면 기존 `runNativeJob`의 completion-unknown/격리 및 상태 확인 절차를 유지해야 합니다. 무조건 다시 완료 요청을 보내지 마세요. 이 수정은 권한 만료를 연장하거나 검증을 생략하지 않습니다.

## 검증
기존 코드에서 12개 실패를 먼저 재현한 뒤 수정했습니다. 추가하여 총 54개 선택 테스트가 로컬에서 통과했습니다. 실제 loopback HTTP로 전체 API 경로, 응답 헤더/본문 지연, 자격 증명 요청 취소, 401 본문 정지, redirect 차단, 완료 응답 유실 시 재전송 없음을 확인했습니다. 20초 경계와 시계 이동 사례는 가상 시계를 사용하는 별도 결정적 테스트입니다.

```sh
pnpm build
node --test packages/ota-runner/test/native-client-reliability.test.ts
node scripts/artifacts/run-tests.mjs
```
전용 `Native transport reliability` CI는 Linux/macOS/Windows에서 선택 테스트를 실행합니다. CI 정의 추가와 실제 CI 성공은 별도이며 PR의 현재 HEAD 결과를 확인해야 합니다. 기존 Foundation 전체 검사도 그대로 유지합니다.

로컬은 관련 코드 추출본, Node 22.16.0, TypeScript 5.8.3 및 제공된 Node 타입을 사용했습니다. 저장소의 strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes/noImplicitOverride/verbatimModuleSyntax 설정으로 선택 소스를 컴파일했고, 기존 로컬 빌드·서명·복구 203개 테스트도 통과했습니다. 전체 모노레포/원래 controller 테스트/Node24·macOS·Windows 검증은 원격 CI에서 별도로 확인합니다.

## 남은 경계
동기적으로 이벤트 루프 자체를 막는 악성 도구를 중단하는 OS 샌드박스가 아닙니다. 서버가 실제로 lease를 연장했는지, 네이티브 앱이 설치됐는지, OTA가 적용됐는지를 이 테스트로 증명하지 않습니다. 테스트 키·토큰은 합성이며 운영 서버·인증서·키·D1·OTA를 변경하지 않았습니다. 코드는 자체 검토했지만 독립 보안 리뷰는 별도입니다.
