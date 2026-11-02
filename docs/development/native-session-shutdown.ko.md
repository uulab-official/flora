# 네이티브 Runner 종료와 재시작 안전 확인

이 변경은 기존 native-main/native-client에 적용한다. 별도 컴파일러나 서명기를 추가하지 않는다. 키·인증서·Cloudflare/OTA 데이터는 수정하지 않는다.

## 명령
전체 저장소의 고정 도구 체인으로 `pnpm build`를 실행한 뒤:

```sh
pnpm flora:native --help
pnpm flora:native --config /absolute/private/native.json --daemon
pnpm flora:native --config /absolute/private/native.json --job native_job_example
```

직접 실행은 `node packages/ota-runner/dist/native-main.js ...`이다. 패키지 bin에 `flora-native-runner`를 추가했지만 설치하지 않은 전역 명령이 존재한다고 가정하지 않는다. 기존 `flora-ota-runner`는 그대로 OTA entry를 가리킨다. 새 단축명은 native 빌드를 위한 것으로 서로 다른 실행기다.

여러 앱은 최대 32개의 서로 다른 `--config`를 daemon에 지정한다. 단일 `--job`은 설정 하나만 받는다. 잘못된/중복 옵션·제어문자·모드 혼합은 설정 파일이나 네트워크 접근 전에 거부한다. help는 설정/네트워크 I/O를 하지 않는다.

## 종료 계약
SIGINT/SIGTERM으로 세션을 종료하면 세션이 소유한 모든 native HTTP client가 같은 종료 신호를 관측한다. pending, presence, claim, heartbeat, credentials, complete, fail 모두 적용된다. 기존 상위 controller가 개별 호출에 신호를 생략해도 CLI 세션의 신호가 유효하다.

라이브러리는 `createNativeClient({...config, signal})`로 opt-in한다. 인자 생략 시 기존 동작이다. 메서드에 별도 신호를 전달하면 둘 중 하나가 중단돼도 요청이 중단된다. 클라이언트끼리 다른 신호를 중단시키지는 않는다. 정상/오류 종료 모두 세션 scope와 부모/프로세스 리스너를 정리한다.

설정 파일 읽기와 로컬 도구 호출 자체를 강제 선점하지 않는다. 읽기 전후에 종료를 확인하여 늦은 결과가 다음 앱 읽기, presence, claim 또는 빌드를 시작하지 못하게 한다. 실제 컴파일러/서명 프로세스의 기존 격리·정리 규칙은 그대로이며 이 패치는 새 OS 샌드박스가 아니다.

## 복구 확인
`--job`도 daemon처럼 `assertNativeReconciled`를 통과해야 한다. 모든 선택 앱을 검사한 뒤 최초 presence/queue/claim 요청을 보낸다. 단일 작업은 비동기 presence 이후에도 다시 검사한다. 기존 미확인 receipt 또는 비어 있지 않은 `.pending`이 있으면 `attention / NATIVE_COMPLETION_RECONCILIATION_REQUIRED`로 종료한다. 파일을 삭제·덮어쓰기·재전송하지 않는다. 기존 daemon의 작업 사이 재검사도 그대로 유지한다.

## 종료 결과
- 운영자 중지: `stopped / NATIVE_CANCELLED`, exit 0. 빌드 성공/서버 rollback의 증거가 아니다.
- daemon이 중지 요청 없이 정상 반환: `stopped / NATIVE_DAEMON_STOPPED`.
- 완료 보고 불명확: `completion_unknown / NATIVE_COMPLETION_UNKNOWN`, exit 1. 동시 중지보다 우선하며 기존 격리/복구 확인을 유지한다.
- 복구 확인 필요: `attention / NATIVE_COMPLETION_RECONCILIATION_REQUIRED`, exit 1.
- 잘못된 입력/설정: exit 2. 기타 실패: exit 1. 개인 경로, 토큰, 오류 원문을 출력하지 않는다.
- 이미 controller가 반환한 확정 성공은 직후 중지 때문에 실패로 바꾸지 않는다.

종료/통신 timeout은 원격 쓰기가 rollback됐다는 의미가 아니다. 쓰기 요청 자동 재전송은 추가하지 않았다. 내부 job controller 자체의 별도 abort 경계와 CLI 운영자 종료는 같은 개념이 아니다.

## 검증 범위
관련 source/tests의 선택 검사와 실제 loopback HTTP를 사용한다. CLI POSIX CI는 실제 compiled native-main, 실제 private config reader, 실제 native daemon을 사용하되 컴파일 전 presence/pending에서 SIGINT/SIGTERM을 보낸다. 원래 격리 환경을 해제하거나 개인 키를 넣지 않는다. 단일 실행의 불명확한 원장/격리 파일 보존도 검사한다. Gradle/Xcode/서명/설치/OTA 완료 증거가 아니다.
