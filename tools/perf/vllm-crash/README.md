# 실제 vLLM 종료·재기동 검증

자동 복구 검증은 `run.mjs --mode auto-retry`를 사용합니다. 원래 작업의 기한·자동 복구·API 응답을 검사합니다. `--mode baseline`은 자동 재시도 수정 전 JAR를 대상으로 별도 사용자 재시도를 확인하는 모드이므로 현재 코드의 기본 시나리오와 구분합니다.

두 모드는 원래 `run.mjs`(baseline)와 `run-retry.mjs`(auto-retry)로 나뉘어 있었고, 공통 함수는 `tools/perf/lib/harness.mjs`로 옮겼다. 산출 파일 이름은 모드별로 그대로 유지한다. `environment.json`의 `harnessSha256`은 실행 스크립트와 공통 파일을 합친 해시다. 2026-10-23 결과는 정리 전 단일 파일 해시라서 `archive.mjs`·`compare-retry.mjs`로 다시 만들려면 커밋 `95af1d6`의 스크립트를 사용한다.

합성 회원 100명의 질문을 접수하고 별도 Worker가 실제 LLM을 호출하는 중 로컬 chat vLLM 컨테이너를 SIGKILL로 종료한다. 15초 뒤 같은 컨테이너·이미지·모델 캐시로 재기동한다. 원래 작업의 자동 처리 결과를 먼저 확정한 뒤, 실패한 작업 하나를 기존 재시도 API로 한 번 재시도해 답변 생성의 복구를 확인한다. 이 별도 1건을 원래 100건의 성공으로 합산하지 않는다.

## 자동 재시도 수정 검증

새 결과 디렉터리를 쓰는 설정 파일(예: `build/chat-burst-live/vllm-retry-config.json`)을 준비한다. `credentials`는 기존 합성 회원 파일이며 `directory`는 존재하지 않는 `build` 하위 폴더여야 한다. 접수는 회원별 한 번, 총 100건이며 사용자 재시도 API는 호출하지 않는다. 기한은 접수+10분과 선점+180초 중 이른 시각이고 모델 연결 오류는 기본 5초 간격으로 재전송한다.

```powershell
docker compose -p ubot-chat-burst-live -f build/chat-burst-live/compose.yml up -d --wait
node tools/perf/vllm-crash/run.mjs --config build/chat-burst-live/vllm-retry-config.json --mode auto-retry
node tools/perf/postgres-crash/prepare-audit.mjs build/chat-burst-live/vllm-retry-100-20261023
```

생성한 읽기 전용 `independent-audit.sql`을 전용 DB에서 실행해 `independent-audit.json`에 저장한다. 최종 Gradle 결과 `regression-tests.json`, 모델 로그 `vllm-restart.log`, 정리 결과 `infrastructure-cleanup.json`을 수집하고 `node tools/perf/vllm-crash/compare-retry.mjs <결과폴더>`로 비교 보고서를 만든다. Worker 실행 토큰·heartbeat·마감 유지, 원래 사용자 시도 횟수 1, 답변 해시·중복·누락을 대조한다.

## 환경과 실행

- 이전 [로컬 장애 검증](../worker-crash/README.md)의 전용 PostgreSQL(25432)·Redis(26379), 합성 회원 credentials 파일, 빌드한 JAR와 Java 21·Node.js·Docker가 필요하다.
- `run.mjs`의 종료 대상은 **`ubot-feat-200-vllm-1` / 8000**으로 하드코딩돼 있다. `docker ps`에서 정확히 같은 테스트 전용 컨테이너인지 확인한 경우에만 실행한다. 이름이 다르면 실행하지 말고 먼저 설정값으로 분리해야 한다. 실행기는 자동 재시작 정책을 잠시 `no`로 바꿔 중단 구간을 확보하고 `finally`에서 원래 `unless-stopped`로 복원하며, 오류가 나도 모델을 다시 시작하고 readiness를 확인한다.
- API 18080·Worker 18081은 이 도구가 생성한다. embedding vLLM(8001), 개발 DB(15432)·Redis(16379)는 종료하지 않는다.
- 각 회원이 비캐시 질문 `분실한 유심을 재발급받으려면 어떻게 하나요?`를 한 번 보낸다. 실제 로그인 JWT·사용자 소유권·100건 QUEUED를 확인한다. 모의 LLM, DB 상태 수정, 원래 100건의 질문 재접수는 사용하지 않는다.
- Worker·LLM 동시 실행 4, heartbeat 1분, 복구 주기 15초, reclaim idle 5분, 대기 제한 10분·실행 제한 180초를 유지한다. 애플리케이션·스키마·운영 설정은 변경하지 않는다.

Git 제외 설정 파일 예:

```json
{
  "directory": "build/chat-burst-live/vllm-crash-100-20261023",
  "credentials": "build/chat-burst-live/burst-1500/credentials.private.json"
}
```

```powershell
docker compose -p ubot-chat-burst-live -f build/chat-burst-live/compose.yml up -d --wait
node --test tools/perf/vllm-crash/model.test.mjs
node tools/perf/vllm-crash/run.mjs --config build/chat-burst-live/vllm-crash-config.json --mode baseline
```

## 결과의 의미

- DB `GENERATING`과 vLLM 실행 중 요청을 함께 확인한 뒤 종료한다. exit 137·컨테이너 시작 시각 변경·같은 이미지와 모델 이름을 확인한다.
- `FAILED`로 저장된 작업은 유실과 구분한다. 타임아웃은 `LLM-004`·`CHAT-016` 실패의 부분집합이다. 누락·미완료·중복 답변·성공인데 답변이 없는 경우를 따로 집계한다.
- 작업 GET의 HTTP 200과 답변 생성 성공을 구분한다. 장애 중 GET이 `200 + data.status=FAILED + data.errorCode=LLM-003`일 수 있다. API health와 모델 readiness도 각각 기록한다.
- HTTP 관측은 별도 Node 스레드에서 2초 제한으로 실행해 Docker 제어의 대기 시간이 측정에 섞이지 않게 한다. 다른 회원은 404, 잘못된 JWT 서명은 401인지 확인한다.
- vLLM 지표는 재기동하면 초기화된다. 재기동 전과 후를 서로 다른 구간으로 취급하고, 별도 복구 재시도의 모델 호출 증가량을 재기동 후 readiness 시점과 비교한다.
- 데이터 일관성 검증과 원래 100건의 자동 답변 복구 성공 여부는 별개다. 실패가 남으면 자동 복구 성공으로 보고하지 않는다.

독립 SQL 대조는 `node tools/perf/vllm-crash/prepare-audit.mjs <결과폴더>`가 생성한 `independent-audit.sql`을 전용 DB에서 실행한다. 출력은 `independent-audit.json`에 저장한다. 원래 100건과 별도 재시도 1건의 상태·오류 코드·소유권·답변 해시·중복·참조·대화 및 멱등키를 확인하는 읽기 전용 쿼리다. 모델 로그·단위 테스트·정리 결과를 수집한 후 `archive.mjs`로 공개 결과를 생성한다.

[검증 방법](../../../docs/testing.md)

## 저장된 기준 자료의 위치

기존 결과는 저장소 밖으로 옮겼습니다. 날짜가 고정된 `compare-*.mjs`·`archive.mjs`는 저장소 안의 과거 결과 JSON을 입력으로 읽으므로 현재 체크아웃만으로 과거 비교를 다시 생성할 수 없습니다. 해당 입력과 실행 당시 증거를 별도로 준비해야 합니다. 실행기와 도구 자체 테스트는 유지했으며 일부 집계기의 고정 출력 경로는 변경하지 않았습니다. 새 결과는 실행 뒤 별도 보관 위치로 옮깁니다.
