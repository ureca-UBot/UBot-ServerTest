# 로컬 PostgreSQL 장애 검증 — 2026-10-23

**작업 복구 PASS.** 실제 LLM 질문 100건 처리 중 전용 PostgreSQL을 SIGKILL로 종료·재기동했다. 재접수 없이 100건 전부 답변이 완료됐고 작업 유실·중복 저장·최종 작업 실패·작업 타임아웃은 0건이다. **DB 중단 중에는 작업 API 조회가 2초 안에 응답하지 못했다.**

## 환경과 주입

- API `APP_ROLE=api` / 18080 / PID 33588, Worker `APP_ROLE=worker` / 18081 / PID 29864. 두 JVM과 Redis·모델 서버는 재시작하지 않았다. PID·프로세스 시작 지표와 Redis run_id가 유지됐다.
- 합성 회원 100명으로 재로그인해 각자 질문을 한 번 전송했다. 100건 모두 고유 jobId·DB QUEUED로 접수한 뒤 Worker를 시작했다. 질문은 비캐시 FAQ “분실한 유심을 재발급받으려면 어떻게 하나요?”다.
- 실제 Qwen3-4B quantized vLLM / BGE-M3, RTX 3060 12 GiB, Worker·LLM 동시 실행 4, JVM당 Xms512m/Xmx2g. 외부 모델을 모의하지 않았다.
- 전용 PostgreSQL 25432 / Redis 26379. PostgreSQL 18.6의 `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`을 유지했다. Hikari·JDBC·Worker·WAL 설정과 운영 코드는 변경하지 않았다. 직전 Redis 조회 수정과 동일한 JAR SHA-256이다.
- 09:16:37.978 KST에 실제 모델 요청 4건을 관측하고 2ms 뒤 PostgreSQL 종료를 요청했다. 종료 직전 DB snapshot은 실행 4건·대기 96건·완료 0건이었다. DB 중단 중에는 SQL 상태를 추정하지 않고 이 snapshot의 시각을 그대로 보존했다.
- `docker kill --signal KILL ubot-chat-burst-live-postgres-1`의 exit code 137을 확인하고 같은 컨테이너·데이터 볼륨으로 재기동했다. graceful shutdown·수동 checkpoint·dump 복원·행 상태 변경은 하지 않았다.
- PostgreSQL 로그에서 `database system was interrupted`, `automatic recovery in progress`, WAL `redo starts` / `redo done`, 연결 수락을 확인했다.

## 복구 시간

| 구간 | 측정 결과 |
|---|---:|
| 종료 요청 → PostgreSQL 종료 | 104ms |
| PostgreSQL 종료 → SQL SELECT 1 성공 | **17.11초** |
| 재기동 요청 → SQL SELECT 1 성공 | 1.65초 |
| SQL 준비 → 대기 작업 소비 재개 | **3.55초** |
| SQL 준비 → API health 첫 정상 표본 | 4.27초 |
| SQL 준비 → Worker health 첫 정상 표본 | 3.52초 |
| SQL 준비 → 새 작업 GET 첫 200 관측 | **4.67초** |
| SQL 준비 → 전체 답변 완료 | 50.86초 |
| 강제 종료 요청 → 전체 답변 완료 | **68.07초** |
| 최초 질문 전송 → 전체 답변 완료 | 91.48초 |

15초 중단을 목표로 했으며 제어·재기동·WAL 복구·SQL 확인을 포함한 실제 DB 중단은 17.11초였다. SQL 준비 완료는 09:16:55.189 KST, 전체 답변 완료는 09:17:46.046 KST다. 답변 시간은 폴링 시각이 아닌 DB `finished_at`으로 계산하고 독립 SQL로 다시 대조했다. API 복구 시각은 표본 주기와 요청 처리 시간을 포함한 관측값이다.

## 작업 보존·중복

| 항목 | 결과 |
|---|---:|
| POST / 202 / 고유 jobId | 100 / 100 / 100 |
| 최종 성공 / 실패 / 작업 타임아웃 / 미완료 | 100 / 0 / 0 / 0 |
| 작업 유실 / 중복 답변 턴 / 중복 완료 로그 | 0 / 0 / 0 |
| 저장된 답변 턴 / 원래 회원의 HTTP 답변 재조회 | 100 / 100 |
| HTTP·DB 답변 해시 일치 | 100 / 100 |
| 작업 실행 시작 / 재실행 / heartbeat 재선점 | 100 / 0 / 0 |
| DB 중단 중 Redis에 보존된 이번 메시지 | 100 / 100 |
| DB 중단 중 Redis 미확인 메시지 | 4 |
| 마지막 Redis PEL / 전체 QUEUED·RUNNING | 0 / 0 |

DB 중단 중 Redis 관측 7회 모두 이번 요청의 메시지 100개가 존재했고 PEL 4개가 유지됐다. 진행 중 4건은 기존 실행 토큰으로 DB 복구 후 성공했으며, 나머지 96건도 그대로 처리됐다. 재실행·heartbeat 회수·완료 기록 실패 후 ACK 보류 로그는 이번 실행에서는 발생하지 않았다. 작업 실패로 닫거나 LLM을 다시 호출하지 않고 답변이 각각 한 번만 저장됐다.

Worker 로그에는 닫힌 PostgreSQL 연결 검증 경고가 남았다. DB SQL 접속 가능 시각보다 API·Worker의 실제 처리가 늦게 회복되는 점도 관측했다. DB 전체 복구와 앱 연결 풀·작업 소비 복구를 같은 시각으로 간주하지 않는다.

별도의 읽기 전용 SQL에서 회원·대화·attempt·답변 턴 각각 100개, 소유권 불일치 0, 결과 참조 일치 100, 답변 내용 일치 100을 확인했다. Worker LLM 성공 지표와 모델 서버 성공 카운터 증가량도 각각 100이다.

## API 응답

- **DB 중단 구간 안에서 시작·종료된 2초 제한 조회 6회는 전부 응답을 확보하지 못했다.** 관측 최대 2136ms다. 클라이언트 제한과 스케줄링 지연이 포함된 값이며 서버가 HTTP 0을 반환한 것은 아니다.
- 별도의 45초 제한 조회 1건은 **20.88초 후 HTTP 200 / QUEUED**로 응답했다. DB가 복구된 뒤 응답한 요청이므로 DB 중단 중의 정상 응답으로 세지 않았다.
- SQL 준비 이후 시작한 2초 제한 조회는 89회 중 88회 200, 1회 응답 실패였다. 재연결 구간을 포함한다. 첫 새 조회 성공 이후의 87회는 모두 200이며 p95 27ms, 최대 34ms였다.
- 잘못된 JWT 서명은 DB 중단 중 HTTP 401로 거절됐다(관측 634ms). HTTP 프로세스가 살아 있는 것과 DB가 필요한 작업 조회가 가능한 것은 별도로 확인했다.
- API health 표본 77회 중 6회, Worker health 표본 53회 중 6회는 정상 응답을 확보하지 못했다. 마지막 100건의 정식 결과 GET은 모두 성공했다.

따라서 **작업 복구는 성공했지만 DB 장애 중 API가 정상 응답했다고 판정하지 않는다.** 이번 요청은 장애 검증이므로 API 오류 정책이나 DB 연결 대기 시간을 바꾸지 않았다.

복구된 실제 답변 예시(job 6451):

> 분실한 유심을 재발급받으려면 먼저 고객센터에서 회선을 일시 정지해 주고, 신분증을 지참하여 가까운 대리점에 방문하여 본인 확인 후 유심을 재발급받을 수 있습니다. 재발급 비용은 매장에서 확인해야 합니다.

## 증거와 재현

- [집계 JSON·독립 SQL·API 표본·상세 증거 SHA-256](20261023-local-postgres-crash.json)
- [재현 스크립트와 절차](../README.md)
- 원본: `build/chat-burst-live/postgres-crash-100-20261023/`. PostgreSQL WAL 복구 로그, 종료 직전·재기동 직후·최종 DB snapshot, 100건 HTTP 답변, Redis 표본과 모델 지표를 보관했다. JWT·비밀번호는 보고서에 포함하지 않는다.
- 실제 장애 실행·독립 DB/HTTP 대조·완료 시각 재계산이 통과했다. 운영 코드·마이그레이션·설정은 변경하지 않았다. 검증용 JVM·전용 DB·Redis는 종료하고 데이터를 보존했다. 기존 개발 DB·Redis·vLLM은 유지했다.

기본 연결 설정의 단일 로컬 실행이다. DB가 연결 대기 한도보다 오래 중단되는 경우, Worker 재선점, replication failover, 디스크·호스트·모델·Redis 동시 장애를 함께 검증한 결과는 아니다.
