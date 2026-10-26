# 실제 LLM 처리 중 PostgreSQL 강제 종료 검증

API와 Worker를 별도 JVM으로 실행해 합성 회원 100명의 질문을 한 번씩 접수한다. DB 처리 단계와 실제 vLLM 실행 중 요청을 확인한 뒤 **전용 PostgreSQL 컨테이너만** SIGKILL로 종료한다. 약 15초 후 같은 데이터 볼륨으로 재기동한다. API·Worker·Redis·모델 서버는 계속 실행하며 질문 재접수, 사용자 재시도, DB 상태·시계 수정은 하지 않는다.

## 로컬 준비와 실행

- Windows, Node.js, Docker Desktop, Java 21과 빌드한 `build/libs/UBot-BE-0.0.1-SNAPSHOT.jar`를 사용한다.
- 기존 [로컬 검증 환경](../worker-crash/README.md)의 전용 PostgreSQL(`ubot-chat-burst-live-postgres-1`, 25432)·Redis(26379), 합성 회원 credentials, 실제 vLLM chat(8000)·BGE-M3 embedding(8001)이 필요하다.
- 개발 PostgreSQL(15432)·Redis(16379)에는 장애를 주입하지 않는다. 전용 DB에 미완료 작업이 있으면 시작을 거절한다.
- API 18080 / Worker 18081은 비어 있어야 한다. JVM당 Xms512m/Xmx2g, Worker·LLM 동시 실행 4로 실행한다.
- 질문은 검색 가능한 비캐시 FAQ `분실한 유심을 재발급받으려면 어떻게 하나요?`다. 성공 응답만으로 LLM 경로라고 간주하지 않고 실제 경로 로그와 모델 지표를 확인한다.
- 대기 제한 10분, 실행 제한 180초, heartbeat 만료 1분, 복구 확인 15초, reclaim idle 5분을 유지한다. DB 드라이버·Hikari·WAL 설정은 변경하지 않는다. 작업 GET은 인증·승계·DB 조회에 1.5초 예산을 적용하며 만료 시 `503 / CHAT-025`를 반환한다.

Git 제외 설정 파일을 만든다. 결과 디렉터리는 존재하지 않는 `build` 하위 경로여야 한다.

```json
{
  "directory": "build/chat-burst-live/postgres-query-fix-final-100-20261023",
  "credentials": "build/chat-burst-live/burst-1500/credentials.private.json",
  "requireFastUnavailable": true
}
```

```powershell
docker compose -p ubot-chat-burst-live -f build/chat-burst-live/compose.yml up -d --wait
node tools/perf/postgres-crash/run.mjs --config build/chat-burst-live/postgres-crash-config.json
```

## 관측과 판정

- 실제 회원 JWT 100개로 각자 POST를 한 번 호출한다. 100건 모두 202·고유 jobId·DB QUEUED로 저장됐는지 확인한 뒤 Worker를 시작한다.
- `fsync`, `synchronous_commit`, `full_page_writes`, PostgreSQL 버전·postmaster 시작 시각·WAL LSN을 읽는다. graceful shutdown, 수동 checkpoint, dump 복원, 데이터 삭제는 사용하지 않는다.
- DB `GENERATING`과 vLLM의 실행 중 요청을 확인한 직후 PostgreSQL만 SIGKILL로 종료한다. exit code 137을 확인한다. 중단 중에는 SQL snapshot을 시도하지 않는다. 종료 직전 DB snapshot의 시각과 상태를 보존하고, Redis의 발행 표시·Stream 메시지·PEL을 관찰한다.
- 장애 중 인증된 작업 GET을 2초 제한으로 반복한다. 별도로 45초 제한의 GET 한 건을 보낸다. 두 경우 모두 DB 중단 중 `503 / CHAT-025`를 2초 안에 받는지 확인한다. `requireFastUnavailable=true`이면 이 조건을 성공 판정에 포함한다. 상태 0은 서버 HTTP 상태가 아니라 클라이언트가 응답을 확보하지 못한 경우다. 잘못된 서명은 401인지 확인한다. HTTP 관측은 별도 Node 스레드에서 실행해 Docker 동기 제어의 지연을 배제한다.
- `docker start` 후 SQL `SELECT 1`이 성공한 시각을 DB 준비 완료로 삼는다. WAL 복구 로그, postmaster 시작 시각 변경과 원래 100건의 보존 여부를 확인한다.
- 동일 jobId를 끝까지 추적한다. 실행 토큰 변경, 재실행 로그와 중복 **저장 답변**을 구분한다. DB 완료 커밋이 실패한 작업의 Redis ACK 보류·heartbeat 회수 여부도 기록한다.
- 완료 시각은 DB `finished_at`으로 계산한다. DB 준비, 대기 작업 소비 재개, API health·인증된 작업 GET 복구, 전체 답변 완료를 나누어 기록한다. DB timestamp는 Asia/Seoul로 해석한다.
- 최종 HTTP 답변 100개·DB 답변 턴·사용자 소유권과 Redis PEL을 확인한다. 중복은 DB 저장본으로 판정하고, 커밋 뒤 저장 완료 로그 수는 참고로만 남긴다. 작업 복구 성공과 장애 중 API 응답 가능 여부를 별도로 판정한다.

상세 원본은 지정한 Git 제외 폴더에 저장한다. JWT·비밀번호는 보고서에 포함하지 않는다. 성공·실패 모두 자신이 생성한 JVM만 정리하며, DB가 내려간 채 예외가 나면 다시 시작한다. 컨테이너·데이터 볼륨은 삭제하지 않는다.

[검증 방법](../../../docs/testing.md)
독립 SQL 대조는 `node tools/perf/postgres-crash/prepare-audit.mjs <결과폴더>`가 만든 `independent-audit.sql`을 전용 DB에 `psql -qAt -v ON_ERROR_STOP=1`로 실행하고 출력 JSON을 `independent-audit.json`으로 저장한다. 쿼리는 읽기 전용이며 HTTP 답변 해시·회원 소유권·중복·저장 결과 참조와 완료 시각을 확인한다. 회귀 결과 `regression-tests.json`, WAL 로그 `postgres-recovery.log`, 서비스 보존·테스트 인프라 정리 결과 `infrastructure-cleanup.json`을 같은 폴더에 기록한 후 `node tools/perf/postgres-crash/compare-query-fix.mjs <결과폴더>`로 비교 보고서를 만든다.

## 저장된 기준 자료의 위치

기존 결과는 저장소 밖으로 옮겼습니다. 날짜가 고정된 `compare-*.mjs`·`archive.mjs`는 저장소 안의 과거 결과 JSON을 입력으로 읽으므로 현재 체크아웃만으로 과거 비교를 다시 생성할 수 없습니다. 해당 입력과 실행 당시 증거를 별도로 준비해야 합니다. 실행기와 도구 자체 테스트는 유지했으며 일부 집계기의 고정 출력 경로는 변경하지 않았습니다. 새 결과는 실행 뒤 별도 보관 위치로 옮깁니다.
