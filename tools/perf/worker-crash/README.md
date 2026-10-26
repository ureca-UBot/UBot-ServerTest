# 실제 LLM 처리 중 Worker 강제 종료 검증

`APP_ROLE=api`와 `APP_ROLE=worker`를 별도 JVM으로 실행한다. 합성 회원 100명이 질문을 한 번씩 접수한 뒤, DB의 답변 생성 단계와 vLLM의 실행 중 요청을 모두 관찰하면 이 도구가 생성한 Worker에만 `SIGKILL`을 보낸다. Windows에서는 `TerminateProcess`로 종료되어 Spring 종료 훅과 대기열 반납을 거치지 않는다. API와 DB·Redis·vLLM은 계속 실행한다. 새 consumer 이름으로 Worker를 다시 띄우고 기존 jobId를 재조회한다. 질문 재접수, 사용자 재시도, DB 상태·시계 변경은 하지 않는다.

운영 애플리케이션·스키마·기본 설정은 변경하지 않는다. Worker 동시 실행 4, heartbeat 만료 1분, 복구 주기 15초, reclaim idle 5분, 대기 제한 10분, 실행 제한 180초를 명시해 기본 정책을 그대로 검증한다. `LLM_MAX_CONCURRENT`는 4다.

## 로컬 준비

- Windows, Node.js, Java 21, Docker Desktop과 빌드한 `build/libs/UBot-BE-0.0.1-SNAPSHOT.jar`가 필요하다.
- 기존 `chat-burst` 검증에서 생성한 **전용 테스트** PostgreSQL(`ubot-chat-burst-live-postgres-1`, 25432)과 Redis(`ubot-chat-burst-live-redis-1`, 26379)를 사용한다. 기존 작업이 미완료이면 실행을 거절한다. 개발 DB(15432)와 Redis(16379)는 사용하지 않는다.
- 실제 vLLM chat(8000, `ubot-chat`)와 BGE-M3 embedding(8001, `ubot-embedding`)을 사용한다. `.env`의 local 프로필은 유지하고 각 자식 프로세스의 연결 환경 변수만 재정의한다.
- 기존 합성 회원 credentials 파일의 첫 100명으로 `/auth/login`을 다시 호출한다. `USER` 역할, 서로 다른 사용자 ID, `@example.test` 계정을 검사한다. JWT와 비밀번호를 결과에 저장하지 않는다.
- 검색 가능한 `분실한 유심을 재발급받으려면 어떻게 하나요?` FAQ가 있어야 하며 해당 FAQ는 `cacheable=false`여야 한다. 판정에서는 예상 경로를 가정하지 않고 실제 `source=LLM` 로그 100건을 요구한다.
- API 18080과 Worker 18081은 비어 있어야 한다. 두 JVM을 각각 최대 2GiB heap으로 실행한다.

저장소 루트에서 Git 제외 경로에 설정을 만든다. `directory`는 존재하지 않는 `build` 하위 경로여야 한다.

```json
{
  "directory": "build/chat-burst-live/worker-crash-100-20261023",
  "credentials": "build/chat-burst-live/burst-1500/credentials.private.json"
}
```

```powershell
node tools/perf/worker-crash/run.mjs --config build/chat-burst-live/worker-crash-config.json
```

## 검증과 시간 정의

- 100번의 POST가 모두 202이고 서로 다른 jobId·소유자를 가진다. Worker 시작 전 100건 모두 DB에 QUEUED로 저장되어야 한다.
- DB `GENERATING`과 모델 서버의 `vllm:num_requests_running > 0`을 모두 관찰한 직후 Worker를 강제 종료한다. 종료 직전·직후 DB snapshot, 직전 모델 지표, Redis PEL을 보존한다. 강제 종료 직후 RUNNING인 작업을 중단 작업으로 정의한다.
- Worker가 없는 동안 같은 jobId를 다섯 번 읽고 API health를 약 1초 간격으로 검사한다. PID와 프로세스 시작 지표가 유지되어야 한다.
- 새 Worker가 기본 heartbeat 정책으로 중단 작업의 실행 토큰(`started_at`)을 변경해 인계받아야 한다. 기존 100개 작업을 HTTP로 다시 조회하여 비어 있지 않은 성공 답변 100개를 확인한다.
- DB에서 성공 상태·사용자·답변 턴(`sub_question_index=1`)을 검사한다. 합법적인 하위 질문 여러 행을 중복 턴으로 세지 않는다. 중복 하위 질문, 빈 답변, 미완료·누락이 없어야 하며(커밋 뒤 저장 완료 로그 수는 참고용) 마지막 Redis PEL은 0이어야 한다.
- `report.json`은 종료 명령부터 첫 중단 작업 재시작/답변 완료/전체 완료 시간을 별도로 기록한다. 완료 시각은 폴링 관측 시각 대신 DB `finished_at`을 쓴다. DB timestamp는 애플리케이션 관례인 Asia/Seoul로 해석한다. `workerReadyAt`은 HTTP readiness 관측 시각이다.
- 재실행은 정상적인 at-least-once 복구다. 중복 **저장 답변**과 구별해 실행 시작 횟수와 여러 번 실행된 jobId를 기록한다. 중단 전 모델 서버에 넘어간 계산이 원격에서 취소됐다는 보장은 하지 않는다.

모든 상세 증거는 지정한 Git 제외 폴더에 남긴다. 실행 성공·실패 모두 도구 자신이 생성한 JVM만 정리하며 DB·Redis 컨테이너와 데이터는 보존한다. 실패를 숨기기 위한 재접수는 하지 않는다. 실행 결과의 `passed=false` 또는 도구 예외는 실패로 취급한다.

[검증 범위와 결과 보관 방법](../../../docs/testing.md)을 확인합니다.
