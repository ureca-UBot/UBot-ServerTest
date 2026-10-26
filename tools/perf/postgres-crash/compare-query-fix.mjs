import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { harnessSha256 } from '../lib/harness.mjs';

const directory = resolve(process.argv[2]);
assert.ok(directory.startsWith(resolve('build') + '\\'));
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const read = name => json(join(directory, name));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const baseline = await json('tools/perf/postgres-crash/results/20261023-local-postgres-crash.json');
const result = await read('report.json');
const environment = await read('environment.json');
const audit = await read('independent-audit.json');
const cleanup = await read('infrastructure-cleanup.json');
const tests = await read('regression-tests.json');
assert.equal(result.passed, true); assert.equal(result.fastUnavailable.passed, true);
assert.equal(environment.jarSha256, await sha('build/libs/UBot-BE-0.0.1-SNAPSHOT.jar'));
assert.equal(environment.harnessSha256, await harnessSha256('tools/perf/postgres-crash/run.mjs'));
assert.equal(environment.probeSha256, await sha('tools/perf/postgres-crash/job-query-probe.mjs'));
for (const key of ['savedJobs', 'uniqueJobs', 'uniqueAttempts', 'uniqueMembers', 'uniqueConversations',
  'succeededJobs', 'succeededAttempts', 'oneAttemptOnly', 'storedTurns', 'resultReferencesMatch', 'clearedRequestContexts']) {
  assert.equal(audit[key], 100, key);
}
for (const key of ['ownershipMismatches', 'answerMismatches', 'duplicateTurns', 'missingOrUnfinished', 'globalOutstanding']) {
  assert.equal(audit[key], 0, key);
}
assert.ok(Math.abs(audit.firstQueuedStartAtMs - Date.parse(result.databaseReadyAt) - result.timingsMs.databaseReadyToQueueResume) < .01);
assert.ok(Math.abs(audit.allAnswersFinishedAtMs - Date.parse(result.killRequestedAt) - result.timingsMs.killToAllAnswers) < .01);
assert.equal(result.executionStarts, 100); assert.equal(result.repeatedExecutions.length, 0);
assert.equal(result.apiProcessStartUnchanged, true); assert.equal(result.workerProcessStartUnchanged, true);
assert.equal(result.redisRunIdUnchanged, true); assert.equal(result.databaseRestartConfirmed, true);
assert.equal(result.databaseExitCode, 137);
assert.ok(result.inFlightOutcomes.every(r => r.status === 'SUCCEEDED' && !r.leaseChanged));
for (const key of ['fsync', 'synchronousCommit', 'fullPageWrites']) assert.equal(environment.durability[key], 'on');
const redis = await read('redis-during-database-outage.json');
assert.ok(redis.length && redis.every(r => r.messagesMatched === 100 && r.pending[0] === 4 && r.runId === result.redisBefore.runId));
const recovery = await readFile(join(directory, 'postgres-recovery.log'), 'utf8');
for (const pattern of [/database system was interrupted/, /automatic recovery in progress/, /redo starts at/, /redo done/, /ready to accept connections/]) {
  assert.match(recovery, pattern);
}
const workerMetrics = await readFile(join(directory, 'worker-after.prom'), 'utf8');
assert.match(workerMetrics, /llm_requests_seconds_count\{kind="answer",outcome="success",role="worker"\} 100$/m);
const modelCount = text => Number(text.match(/^vllm:request_success_total\{[^\n]*finished_reason="stop"[^\n]*\}\s+(\S+)$/m)[1]);
const actualLlmCalls = modelCount(await readFile(join(directory, 'vllm-after.prom'), 'utf8')) -
  modelCount(await readFile(join(directory, 'vllm-before.prom'), 'utf8'));
assert.equal(actualLlmCalls, 100);
function stats(rows) {
  const elapsed = rows.map(r => r.elapsedMs).sort((a, b) => a - b);
  const percentile = p => elapsed[Math.max(0, Math.ceil(p * elapsed.length) - 1)] ?? null;
  return { count: rows.length, statuses: rows.reduce((counts, r) => ({ ...counts, [r.httpStatus]: (counts[r.httpStatus] ?? 0) + 1 }), {}),
    clientFailures: rows.filter(r => r.httpStatus === 0).length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: percentile(1) };
}
const down = Date.parse(result.databaseExitedAt), ready = Date.parse(result.databaseReadyAt);
const during = result.outageJobReads.filter(r => Date.parse(r.at) >= down && Date.parse(r.completedAt) <= ready);
const after = result.outageJobReads.filter(r => Date.parse(r.at) >= ready);
const first = after.find(r => r.httpStatus === 200);
assert.ok(first);
const stable = after.filter(r => Date.parse(r.at) >= Date.parse(first.completedAt));
assert.ok(during.length && during.every(r => r.httpStatus === 503 && r.errorCode === 'CHAT-025' && r.elapsedMs < 2000));
assert.ok(stable.length && stable.every(r => r.httpStatus === 200));
assert.equal(result.longRead.httpStatus, 503); assert.ok(result.longRead.elapsedMs < 2000);
assert.equal(tests.failures, 0); assert.equal(tests.errors, 0); assert.ok(tests.tests >= 194);
assert.equal(cleanup.scenarioProcessesRemaining, 0); assert.equal(cleanup.originalServicesAllRunning, true);
assert.ok(cleanup.isolatedContainers.every(c => !c.Running && c.ExitCode === 0));
const evidence = [];
for (const name of ['environment.json', 'events.json', 'submissions.json', 'immediately-before-kill.json',
  'database-after-restart.json', 'immediately-after-database-ready.json', 'redis-during-database-outage.json',
  'api-final.json', 'db-final.json', 'api-health.json', 'worker-health.json', 'outage-job-reads.json', 'outage-long-read.json',
  'outage-invalid-token.json', 'report.json', 'independent-audit.sql', 'independent-audit.json', 'postgres-recovery.log',
  'worker-after.prom', 'vllm-before.prom', 'vllm-after.prom', 'cleanup.json', 'infrastructure-cleanup.json',
  'regression-tests.json', 'api.log', 'worker.log']) evidence.push({ name, sha256: await sha(join(directory, name)) });
const comparison = { date: '2026-10-23', scenario: 'postgres-query-deadline-100-real-llm',
  baseline: { source: '20261023-local-postgres-crash.json', sha256: await sha('tools/perf/postgres-crash/results/20261023-local-postgres-crash.json'),
    jarSha256: baseline.environment.jarSha256, clientObservations: baseline.clientObservations, timingsMs: baseline.result.timingsMs },
  environment: { ...environment, models: environment.models.map(m => m.data.map(({ id, root }) => ({ id, root }))) }, result,
  clientObservations: { duringDatabaseDown: stats(during), afterSqlReady: stats(after), afterFirstFreshSuccess: stats(stable),
    longRead: result.longRead, invalidToken: result.invalidTokenChecks }, independentAudit: audit, tests, actualLlmCalls, cleanup, evidence,
  rawEvidenceDirectory: process.argv[2],
  limitations: ['로컬 단일 실행 비교이며 LLM 처리량을 개선한 변경은 아니다.',
    '이전 HTTP 관측은 Docker 동기 실행의 스케줄링 지연을 포함한다. 수정 후는 별도 Node 관측 스레드로 분리했다.',
    '2초 제한은 작업 GET의 DB 대기에 적용한다. actuator health나 다른 API의 전역 DB 대기 설정은 바꾸지 않았다.',
    'JDBC 취소는 최선의 시도이며 취소에 늦게 반응하는 호출은 최대 8개로 제한한다. 용량 소진도 503으로 응답한다.'] };
const serialized = JSON.stringify(comparison, null, 2) + '\n';
assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
assert.doesNotMatch(serialized, /"(?:accessToken|refreshToken|password)"\s*:/);
const output = 'tools/perf/postgres-crash/results/20261023-postgres-query-fix-comparison';
await writeFile(output + '.json', serialized);
const seconds = n => (n / 1000).toFixed(2);
const old = baseline.result.timingsMs, current = result.timingsMs;
await writeFile(output + '.md', `# PostgreSQL 장애 중 작업 조회 제한 비교 — 2026-10-23

**PASS. 최종 JAR의 실제 LLM 100건에서 장애 중 작업 GET 전부 2초 안에 503을 반환했다.** 재접수 없이 답변 100건이 복구됐고 유실·중복·최종 작업 실패·작업 타임아웃은 0건이다.

## 변경과 원인

기존 인증 필터는 JWT 검증 뒤 DB에서 사용자를 조회한다. PostgreSQL이 내려가면 컨트롤러에 도달하기 전 Hikari 연결을 기다린다. 조회 서비스에만 제한을 추가하면 이 지연은 남는다.

**GET /chat/jobs/{jobId}**의 사용자 조회·비회원 대화 승계·작업 조회가 요청별 **1.5초 예산**을 공유하도록 했다. 대기가 만료되거나 DB 접근이 실패하면 **503 / CHAT-025**로 응답한다. JWT 서명·토큰 차단·작업 소유권 검사를 유지한다. 요청·세션 접근과 응답 쓰기는 원래 요청 스레드에서 처리하고, 필요한 DB 작업만 별도 실행한다.

취소되지 않는 JDBC 호출은 최대 8개이며 추가 대기열 없이 503으로 돌려보낸다. 조회 취소는 답변 작업을 취소하지 않는다. 질문 접수·Worker·전역 Hikari/JDBC 설정·스키마는 변경하지 않았다.

## 같은 시나리오 비교

합성 회원 100명 재로그인·100건 202 접수 후 API와 Worker를 별도 JVM으로 유지했다. 실제 Qwen3-4B vLLM 요청 4개와 DB 실행 4건·대기 96건을 확인하고 전용 PostgreSQL에 SIGKILL(exit 137)을 주입했다. 약 15초 뒤 같은 볼륨으로 재기동했다. Worker·LLM 동시 실행은 4이고 heartbeat·복구 주기·실행 제한·WAL 설정은 동일하다. Redis와 모델 서버는 재시작하지 않았다.

| 항목 | 수정 전 | 수정 후 |
|---|---:|---:|
| DB 중단 중 반복 조회 | 6/6 클라이언트 2초 제한 초과 | **${during.length}/${during.length} HTTP 503** |
| 중단 중 반복 조회 p50 / p95 / 최대 | 2,001 / 2,136 / 2,136ms¹ | **${stats(during).p50Ms} / ${stats(during).p95Ms} / ${stats(during).maxMs}ms** |
| 45초 제한으로 보낸 조회 1건 | 20,882ms 뒤 HTTP 200 | **${result.longRead.elapsedMs}ms 뒤 HTTP 503** |
| PostgreSQL 종료 → SQL 준비 | ${seconds(old.databaseUnavailable)}초 | ${seconds(current.databaseUnavailable)}초 |
| SQL 준비 → 새 작업 GET 첫 200 | ${seconds(old.databaseReadyToJobHealthy)}초 | **${seconds(current.databaseReadyToJobHealthy)}초** |
| SQL 준비 → 대기 작업 소비 재개 | ${seconds(old.databaseReadyToQueueResume)}초 | ${seconds(current.databaseReadyToQueueResume)}초 |
| 종료 요청 → 전체 답변 완료 | ${seconds(old.killToAllAnswers)}초 | **${seconds(current.killToAllAnswers)}초** |
| SQL 준비 → 전체 답변 완료 | ${seconds(old.databaseReadyToAllAnswers)}초 | ${seconds(current.databaseReadyToAllAnswers)}초 |
| 최종 성공 / 작업 실패 / 작업 타임아웃 | 100 / 0 / 0 | **100 / 0 / 0** |
| 작업 유실 / 중복 저장 / 재실행 | 0 / 0 / 0 | **0 / 0 / 0** |

¹ 이전 상태 0은 서버의 HTTP 상태가 아니라 클라이언트가 응답을 받지 못했다는 뜻이다. 2,136ms에는 기존 Docker 동기 관측의 스케줄링 지연도 포함된다. 수정 후 HTTP 시계는 별도 Node 스레드로 분리해 이 간섭을 제거했다. 전체 답변 완료 시간의 차이는 단일 실행 편차이며 LLM 성능 향상으로 해석하지 않는다.

첫 정상 조회 이후 ${stable.length}건은 모두 200이었다(p95 ${stats(stable).p95Ms}ms, 최대 ${stats(stable).maxMs}ms). 잘못된 JWT 서명은 DB 중단 중에도 401이었다. actuator health는 기존 DB 상태 확인 동작을 유지한다.

## 검증 근거

- 실제 모델 성공 증가량 ${actualLlmCalls}건, Worker LLM 경로 100건·실행 시작 100건·완료 100건을 확인했다. LLM 모의 응답은 사용하지 않았다.
- 독립 읽기 전용 SQL로 회원·작업·시도·대화·저장 답변 각 100건, HTTP 답변 해시와 DB 답변 100/100 일치, 잘못된 소유권·중복·누락 0건을 확인했다. 최종 PEL과 전체 미완료 작업도 0건이다.
- PostgreSQL WAL redo 복구, postmaster 시작 시각 변경, Redis run_id·API/Worker 시작 시각 유지, 실행 중 4건의 lease 유지도 확인했다.
- 회귀 테스트 **${tests.tests}건 통과**. 실제 PostgreSQL 정지, 쿼리 잠금, 비회원 승계 잠금, 합산 예산, 대기 취소, 실행 상한, 인증·소유권·비회원·채팅 동작을 포함한다. **bootJar** 성공.
- 테스트 JVM을 정리하고 전용 DB·Redis만 정지했다. 기존 개발 서비스 4개와 모든 데이터 볼륨은 유지했다.

[기존 결과](20261023-local-postgres-crash.md) · [비교 원본 JSON](20261023-postgres-query-fix-comparison.json). 원본 증거 폴더: ${process.argv[2]}. JSON에 JAR·도구·증거 SHA-256을 기록했다.
`);
console.log(JSON.stringify({ passed: true, reads: stats(during), longReadMs: result.longRead.elapsedMs,
  timingsMs: result.timingsMs, tests: tests.tests }));
