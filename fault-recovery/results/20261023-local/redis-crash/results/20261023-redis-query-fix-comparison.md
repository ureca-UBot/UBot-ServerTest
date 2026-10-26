# Redis 장애 중 작업 조회 지연 수정·재검증 — 2026-10-23

**PASS.** 토큰 폐기 조회의 대기를 제한한 뒤 같은 실제 LLM 100건 Redis 장애 시나리오를 재실행했다. Redis 중단 중 작업 조회 20회가 모두 HTTP 200으로 응답했고 최대 511ms였다. 기존 실행은 6회 모두 2초 안에 응답을 받지 못했다. 답변은 두 실행 모두 100건 성공·유실 0·중복 저장 0이었다.

## 원인과 수정 범위

작업 조회 서비스는 새 작업의 결과를 DB에서 읽지만 그 앞의 인증 필터가 Redis에 접근했다. 기존 JAR로 완성된 작업을 조회하는 동안 Redis를 종료하고 3초 뒤 JVM thread dump를 찍었다. 실제 대기 경로는 다음과 같았다.

`JwtAuthenticationFilter.doFilterInternal → AccessTokenRevocationService.isRevoked → LettuceStringCommands.get → LettuceConnection.await → LettuceFutures.awaitOrCancel → CompletableFuture.get`

요청은 Redis를 다시 띄운 뒤 총 4.72초 만에 HTTP 200으로 끝났다. DB 상태 조회에 도달하기 전에 동기 Redis GET의 재연결 대기에 묶이는 것이 원인이었다.

운영 코드 변경은 `AccessTokenRevocationService` 한 파일이다. 토큰 폐기 기록 조회를 기존 프레임워크의 `ReactiveStringRedisTemplate`로 수행하고 이 GET에만 **200ms 한도**를 뒀다. 제한이 지나면 구독을 취소하고 기존 Redis 오류 처리 경로로 넘긴다. 별도 대기 스레드나 전역 Redis timeout 변경은 없다. 로그아웃 기록의 키·TTL·저장 방식, Worker의 Stream/ACK/재발행·블로킹 읽기 설정을 변경하지 않았다.

기존 Redis 장애 시 토큰 폐기 조회를 생략하는 정책을 유지한다. JWT 서명·사용자 존재 여부·작업 소유권 검사는 계속 수행한다. 장애 중 본인은 200, 다른 회원은 404, 서명을 바꾼 토큰은 401임을 실제 HTTP로 확인했다. Redis가 회복되면 다음 조회부터 차단 기록을 다시 확인하며 장애 상태를 장기간 캐시하지 않는다.

## 동일 100건 비교

실제 Qwen3-4B vLLM과 BGE-M3, 합성 회원 100명, 비캐시 FAQ의 동일 질문, API/Worker 분리, Worker·LLM 동시 실행 4, Redis 약 15초 중단, 2초 HTTP 클라이언트 제한을 유지했다. 재접수·사용자 재시도는 하지 않았다. 변경 전후 JAR SHA-256과 환경은 비교 JSON에 기록했다. 조회 표본은 모두 Redis 실제 종료~PONG 사이에 시작·완료된 요청이다. 기존 실행과 같은 QUEUED 작업의 조회를 비교했다.

| 항목 | 변경 전 | 변경 후 |
|---|---:|---:|
| Redis 중단 중 조회 200 / 관측 횟수 | 0 / 6 | **20 / 20** |
| 조회 응답 실패·2초 제한 초과 | 6 | **0** |
| 조회 관측 p50 | 2005ms (클라이언트 제한) | 228ms |
| 조회 관측 p95 | 2012ms (클라이언트 제한) | 465ms |
| 조회 관측 최대 | 2012ms (클라이언트 제한) | **511ms** |
| Redis 실제 중단 | 16.57초 | 16.55초 |
| PONG → 대기 작업 소비 재개 | 2.84초 | 2.98초 |
| 강제 종료 요청 → 전체 답변 완료 | 65.61초 | **64.50초** |
| 최초 질문 전송 → 전체 답변 완료 | 87.16초 | 86.19초 |
| 답변 성공 / 작업 실패 / 작업 타임아웃 | 100 / 0 / 0 | 100 / 0 / 0 |
| 작업 유실 / 중복 답변 저장 | 0 / 0 | 0 / 0 |

변경 전 서버의 최종 응답 시간을 2초로 단정하지 않는다. 클라이언트가 2초에 관측을 중단한 값이다. 같은 500ms 간격으로 다음 조회를 시도하므로 빠르게 응답한 변경 후 실행의 표본 수가 더 많다. 전체 완료 시간 차이는 -1.11초이며 각각 한 번의 로컬 실행이므로 GPU 처리량의 통계적 개선으로 해석하지 않는다.

## 복구·회귀 검증

- Redis의 최근 Stream 메시지 100개가 사라진 상태에서 대기 96건을 DB 기록으로 자동 재발행했다(배치: 96). 원래 API·Worker PID가 유지됐다.
- 동일 jobId 100개를 원래 회원 JWT로 재조회했고 HTTP 답변·DB 답변 내용 100개가 모두 일치했다. 작업 실행 시작 100회·재실행 0회, 답변 턴 100개·중복 완료 로그 0, 마지막 Redis PEL 0이었다.
- 새 Worker의 실제 LLM 성공 지표와 모델 서버 성공 카운터 증가량은 각각 100이다. 모의 LLM을 사용하지 않았다.
- 인증·토큰 폐기·Stream Java 테스트 **46개**, snapshot 분석 테스트 **2개**가 통과했다. 실제 Redis를 pause한 통합 테스트에서 조회 제한과 복구 후 토큰 차단 재적용을 확인했다. 같은 Redis 연결의 1초 블로킹 읽기가 유지되는 것도 검증했다.
- Redis에 의존하는 health 검사는 장애를 계속 반영한다. 작업 조회가 성공했다고 Redis나 전체 health가 정상이라고 판정하지 않는다.
- 검증용 JVM·전용 DB·Redis는 종료했고 데이터를 보존했다. 기존 개발 DB·Redis·vLLM은 유지했다.

## 결과 파일

- [비교 JSON·원인 스택·독립 SQL·상세 증거 해시](20261023-redis-query-fix-comparison.json)
- [변경 전 결과](20261023-local-redis-crash.md)
- [재현 절차](../README.md)
- 수정 후 원본: `build/chat-burst-live/redis-crash-fixed-100-20261023/`, 원인 추적: `build/chat-burst-live/redis-auth-diagnosis-20261023/`.

동일 머신의 단일 비교이며 장기 Redis 장애·Redis 클러스터 failover·API 재기동 중 Redis 장애·새 로그인·로그아웃 자체의 응답 시간은 이번 비교 범위에 포함하지 않는다.
