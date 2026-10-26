# 실제 LLM 처리 중 Redis 강제 종료 검증

API와 Worker를 별도 JVM으로 실행하고 합성 회원 100명으로 로그인해 질문을 한 번씩 보낸다. DB `GENERATING`과 실제 vLLM의 실행 중 요청을 확인하면 **전용 Redis 컨테이너만** SIGKILL로 종료한다. 약 15초 후 같은 Redis 컨테이너를 재기동한다. API·Worker·PostgreSQL·모델 서버는 계속 실행하며 질문 재접수·사용자 재시도·DB 상태 변경은 하지 않는다.

## 실행 조건

- Windows, Node.js, Docker Desktop, Java 21과 빌드된 `build/libs/UBot-BE-0.0.1-SNAPSHOT.jar`를 사용한다.
- [기존 로컬 검증 환경](../worker-crash/README.md)의 전용 DB(25432)·Redis(26379), 합성 회원 credentials, 실제 vLLM chat(8000)·BGE-M3 embedding(8001)이 필요하다. 개발 DB(15432)·Redis(16379)에는 장애를 주입하지 않는다.
- 전용 DB에 미완료 작업이 있으면 실행을 거절한다. API 18080 / Worker 18081은 비어 있어야 한다. 각 JVM은 Xms512m/Xmx2g로 시작한다.
- 검색 가능한 비캐시 FAQ 질문 `분실한 유심을 재발급받으려면 어떻게 하나요?`를 사용한다. 최종 LLM 경로 100건은 실제 로그와 답변으로 검증한다.
- Worker·LLM 동시 실행 4, 대기 제한 10분, 실행 제한 180초, 재발행 기준 30초, 복구 확인 15초, heartbeat 만료 1분을 사용한다. 기본 복구 정책과 Redis 영속성 설정을 변경하지 않는다.

저장소 루트에서 Git 제외 설정 파일을 만든다. 결과 디렉터리는 존재하지 않는 `build` 하위 경로여야 한다.

```json
{
  "directory": "build/chat-burst-live/redis-crash-100-20261023",
  "credentials": "build/chat-burst-live/burst-1500/credentials.private.json"
}
```

```powershell
docker compose -p ubot-chat-burst-live -f build/chat-burst-live/compose.yml up -d --wait
node tools/perf/redis-crash/run.mjs --config build/chat-burst-live/redis-crash-config.json
```

## 검증 기준

- 서로 다른 실제 USER JWT 100개로 각자 POST를 한 번 보내고, 모두 202·고유 jobId·DB QUEUED로 접수돼야 한다. 먼저 API만 실행해 접수한 뒤 Worker를 시작한다.
- DB 처리 단계와 모델 서버 실행 지표를 함께 확인한다. 전용 Redis만 `docker kill --signal KILL`로 종료됐고 exit code 137이며, 재기동 후 `run_id`가 달라졌는지 확인한다. graceful shutdown·FLUSHDB·수동 재발행은 사용하지 않는다.
- 장애 전후 발행 표시와 그 표시가 가리키는 실제 Stream 메시지의 jobId를 확인한다. Redis 데이터가 복원됐는지, DB의 QUEUED 작업을 Worker가 자동 재발행했는지 구분한다. 재기동 직후 snapshot은 Worker의 재발행과 경쟁할 수 있으므로 관측 시점을 함께 기록한다.
- Redis가 없는 동안 DB 작업 상태, API·Worker health, 인증된 작업 조회를 관찰한다. HTTP 클라이언트 제한은 2초다. 상태 0은 클라이언트가 응답을 확보하지 못한 경우이며 서버가 HTTP 0을 보냈다는 뜻은 아니다. 장애 중 API 오류를 작업 유실과 별도로 집계한다.
- 복구 후 동일 API·Worker 프로세스에서 원래 jobId의 실제 답변 100개를 다시 읽는다. DB 답변 턴·하위 질문 중복·사용자 소유권을 확인하고(커밋 뒤 저장 완료 로그 수는 참고용) Redis PEL이 비었는지 검사한다.
- 재실행과 중복 **저장 답변**을 구분한다. 장애 당시 실행 중이던 작업은 살아 있는 Worker가 그대로 끝낼 수도 있다.
- 종료 명령과 DB snapshot 사이에 완료된 작업은 원본 시작·완료 시각으로 장애 당시 상태를 역산한다. snapshot을 받은 시각의 성공 건수를 장애 시점의 성공으로 세지 않는다. 이 계산은 `analysis.test.mjs`로 검증한다.
- 완료 시각은 DB `finished_at`으로 계산한다. Redis PONG, 대기 작업 소비 재개, 전체 답변 완료 시간을 별도로 남긴다. DB timestamp는 Asia/Seoul로 해석한다.

상세 증거는 지정한 Git 제외 폴더에 저장한다. JWT·비밀번호를 보고서에 쓰지 않는다. 성공·실패 모두 자신이 생성한 JVM만 정리하며, Redis가 중단된 채 예외가 나면 다시 시작한다. DB·Redis 컨테이너와 데이터는 도구가 삭제하지 않는다.

[검증 방법](../../../docs/testing.md)

재검증 설정에 아래 항목을 추가하면 장애 중 본인 조회가 2초 안에 응답하는지와 다른 회원·잘못된 JWT의 접근 거절도 필수로 검사한다. 토큰 폐기 조회가 200ms를 넘겨도 Redis 장애와 같이 차단 없이 진행하므로, 장애 중 본인 조회는 200이어야 한다. 200이 아니면 응답의 오류 코드를 `errorCode`에 남긴다. 기존 비교와 같이 대기 중인 작업을 조회한다.

```json
{
  "directory": "build/chat-burst-live/redis-crash-fixed-100-20261023",
  "credentials": "build/chat-burst-live/burst-1500/credentials.private.json",
  "requireOutageReadSuccess": true,
  "watchQueuedJob": true
}
```

```powershell
node --test tools/perf/redis-crash/analysis.test.mjs
```
