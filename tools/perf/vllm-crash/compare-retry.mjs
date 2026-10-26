import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { summarize, latency } from './model.mjs';
import { harnessSha256 } from '../lib/harness.mjs';

const directory = resolve(process.argv[2]); assert.ok(directory.startsWith(resolve('build') + '\\'));
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const read = name => json(join(directory, name));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const baselinePath = 'tools/perf/vllm-crash/results/20261023-local-vllm-crash.json';
const baseline = await json(baselinePath);
const result = await read('report.json'), environment = await read('environment.json');
const audit = await read('independent-audit.json'), cleanup = await read('infrastructure-cleanup.json');
const restored = await read('model-restored.json'), tests = await read('regression-tests.json');
const rows = (await read('db-final.json')).rows, snapshots = await read('db-snapshots.json');
assert.equal(result.verificationPassed, true);
assert.deepEqual(result.summary, summarize(rows, await read('submissions.json'), await read('api-final.json')));
assert.equal(result.summary.succeeded, 100); assert.equal(result.summary.failed, 0); assert.equal(result.summary.timeouts, 0);
assert.equal(environment.jarSha256, await sha('build/libs/UBot-BE-0.0.1-SNAPSHOT.jar'));
assert.notEqual(environment.jarSha256, baseline.environment.jarSha256);
assert.equal(environment.mode, 'auto-retry');
assert.equal(environment.harnessSha256, await harnessSha256('tools/perf/vllm-crash/run.mjs'));
assert.equal(environment.modelSha256, await sha('tools/perf/vllm-crash/model.mjs'));
assert.equal(environment.probeSha256, await sha('tools/perf/vllm-crash/probe.mjs'));
// 한 스크립트에 baseline의 사용자 재시도 코드도 있으므로 소스가 아닌 실행 결과로 재시도가 없었음을 확인함
assert.equal(environment.manualRetryRequests, 0); assert.equal(result.manualRetryRequests, 0);
assert.equal(await readFile(join(directory, 'recovery-probe.json')).then(() => true, () => false), false, '사용자 재시도 결과가 있습니다.');
for (const key of ['savedJobs', 'uniqueJobs', 'uniqueAttempts', 'uniqueMembers', 'uniqueConversations',
  'succeededJobs', 'succeededAttempts', 'oneAttemptOnly', 'storedTurns', 'resultReferencesMatch', 'clearedRequestContexts']) assert.equal(audit[key], 100, key);
for (const key of ['ownershipMismatches', 'answerMismatches', 'duplicateTurns', 'missingOrUnfinished', 'globalOutstanding']) assert.equal(audit[key], 0, key);
assert.ok(Math.abs(audit.allAnswersFinishedAtMs - Date.parse(result.killRequestedAt) - result.timingsMs.killToAllAnswers) < .01);
assert.equal(result.manualRetryRequests, 0); assert.equal(result.userAttemptCountUnchanged, true);
assert.ok(result.inFlight.length && result.inFlight.every(r => r.startedAtMs === r.finalStartedAtMs));
assert.equal(result.originalExecutionStarts, 100); assert.equal(result.repeatedOriginalExecutions.length, 0);
assert.deepEqual(environment.models, baseline.environment.models);
assert.equal(environment.concurrency, baseline.environment.concurrency);
assert.equal(environment.executionTimeoutMs, baseline.environment.executionTimeoutMs);
assert.equal(environment.queueTimeoutMs, baseline.environment.queueTimeoutMs);
const budgetChecks = [];
for (const running of result.inFlight) {
  const samples = snapshots.flatMap(s => s.rows.filter(r => r.jobId === running.jobId && r.status === 'RUNNING'));
  assert.ok(samples.length);
  const deadlines = [...new Set(samples.map(r => r.deadlineAtMs))];
  assert.equal(deadlines.length, 1);
  const expected = Math.min(samples[0].createdAtMs + environment.totalTimeoutMs, running.startedAtMs + environment.executionTimeoutMs);
  assert.ok(Math.abs(deadlines[0] - expected) < 1);
  assert.ok(samples.some(r => r.phase === 'WAITING_FOR_MODEL'));
  assert.ok(Math.max(...samples.map(r => r.heartbeatAtMs ?? 0)) > running.startedAtMs + 15000);
  budgetChecks.push({ jobId: running.jobId, deadlineAtMs: deadlines[0], unchanged: true, heartbeatRenewed: true });
}
assert.ok(rows.every(r => r.finishedAtMs - r.createdAtMs < environment.totalTimeoutMs));
assert.ok(restored.running); assert.deepEqual(restored.restartPolicy, environment.originalModel.restartPolicy);
assert.equal(restored.id, environment.originalModel.id); assert.equal(restored.image, environment.originalModel.image);
assert.equal(cleanup.scenarioProcessesRemaining, 0); assert.equal(cleanup.originalServicesAllRunning, true);
assert.ok(cleanup.isolatedContainers.every(c => !c.Running && c.ExitCode === 0));
assert.equal(cleanup.modelRestartPolicy, 'unless-stopped');
const workerMetrics = await readFile(join(directory, 'worker-after.prom'), 'utf8');
assert.match(workerMetrics, /llm_requests_seconds_count\{kind="answer",outcome="success",role="worker"\} 100$/m);
const waits = Number(workerMetrics.match(/^chat_worker_model_retry_waits_total\{[^\n]+\}\s+(\S+)$/m)[1]);
assert.equal(waits, result.retryWaits); assert.ok(waits > 0);
const modelMetrics = await readFile(join(directory, 'vllm-after-recovery.prom'), 'utf8');
const modelSuccess = [...modelMetrics.matchAll(/^vllm:request_success_total\{[^\n]*finished_reason="stop"[^\n]*\}\s+(\S+)$/gm)]
  .reduce((n, m) => n + Number(m[1]), 0);
assert.equal(modelSuccess, 100);
for (const role of ['api', 'worker']) {
  const start = text => text.match(/^process_start_time_seconds.*$/m)?.[0];
  const before = start(await readFile(join(directory, `${role}-before.prom`), 'utf8'));
  assert.ok(before); assert.equal(start(await readFile(join(directory, `${role}-after.prom`), 'utf8')), before);
}
const reads = await read('api-job-reads.json');
const during = reads.filter(r => Date.parse(r.at) >= Date.parse(result.modelExitedAt) && Date.parse(r.completedAt) <= Date.parse(result.modelReadyAt));
assert.deepEqual(latency(during), result.apiDuringModelUnavailable);
assert.ok(during.length && during.every(r => r.httpStatus === 200 && r.elapsedMs < 2000));
assert.equal(tests.failures, 0); assert.equal(tests.errors, 0); assert.equal(tests.tests - tests.skipped, 244);
const restartLog = await readFile(join(directory, 'vllm-restart.log'), 'utf8');
assert.match(restartLog, /Application startup complete/); assert.match(restartLog, /Capturing CUDA graphs/);
const evidence = [];
for (const name of ['environment.json', 'events.json', 'submissions.json', 'immediately-before-kill.json',
  'database-before-model-restart.json', 'db-final.json', 'db-snapshots.json', 'api-final.json', 'api-job-reads.json',
  'api-health.json', 'model-health.json', 'security-checks.json', 'report.json', 'independent-audit.sql', 'independent-audit.json',
  'vllm-restart.log', 'vllm-before.prom', 'vllm-immediately-before-kill.prom', 'vllm-ready.prom', 'vllm-after-recovery.prom',
  'api-before.prom', 'api-after.prom', 'worker-before.prom', 'worker-after.prom', 'model-restored.json',
  'cleanup.json', 'infrastructure-cleanup.json', 'regression-tests.json', 'api.log', 'worker.log']) evidence.push({ name, sha256: await sha(join(directory, name)) });
const comparison = { date: '2026-10-23', timezone: 'Asia/Seoul', scenario: 'vllm-auto-retry-100-real-llm',
  baseline: { source: baselinePath, sha256: await sha(baselinePath), summary: baseline.result.summary,
    timingsMs: baseline.result.timingsMs, api: baseline.result.apiDuringModelUnavailable },
  environment, result, independentAudit: audit, fixedDeadlineChecks: budgetChecks, modelSuccessfulCallsAfterRestart: modelSuccess,
  tests, cleanup, finalModelRestored: restored, rawEvidenceDirectory: process.argv[2], evidence,
  limitations: ['로컬 각 1회 실행이며 모델 재초기화 시간 차이를 애플리케이션 성능 향상으로 해석하지 않는다.',
    '수정 전 원래 100건은 모두 실패했고 별도 사용자 재시도 1건만 성공했다. 수정 후에는 사용자 재시도 없이 원래 100건이 성공했다.',
    '기한 만료·취소·4xx·도구 중복 방지는 테스트에서 검증하고 실제 장애 실험은 동일 SIGKILL·재기동 조건으로 수행했다.'] };
const serialized = JSON.stringify(comparison, null, 2) + '\n';
assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
assert.doesNotMatch(serialized, /"(?:accessToken|refreshToken|password)"\s*:/);
const output = 'tools/perf/vllm-crash/results/20261023-vllm-retry-comparison';
await writeFile(output + '.json', serialized);
const sec = n => (n / 1000).toFixed(2), old = baseline.result, t = result.timingsMs;
await writeFile(output + '.md', `# vLLM 자동 재시도 수정 전후 비교 — 2026-10-23

**원래 100건이 사용자 재시도 없이 모두 성공했다.** 작업 유실·중복 답변·최종 실패·타임아웃은 모두 0건이다. 수정 전에는 같은 장애에서 원래 100건이 LLM-003으로 최종 실패했다.

## 시간 제한과 동작

- **5초 간격**: Worker 안의 vLLM 연결 실패·5xx만 같은 HTTP 요청으로 다시 보낸다. 4xx·잘못된 응답·HTTP 타임아웃과 Worker 밖 호출은 기존 오류 처리를 유지한다.
- **한 실행 180초**: 모델 복구 대기·FAQ 검색·도구·LLM을 모두 포함한다. HTTP 재시도마다 새 180초를 주지 않는다. Worker Future가 기한에 계산을 취소하며 늦은 결과를 저장하지 않는다.
- **접수 후 전체 10분**: 실제 마감은 접수+10분과 선점+180초 중 이른 시각이다. Worker가 넘겨받아도 접수 시각은 유지한다. 만료된 대기 작업은 다음 정리 주기에 실패 상태로 반영되며, 선점 SQL은 만료 후 실행을 막는다.
- 새 작업·사용자 시도를 만들지 않는다. 장애 중 최초 4건이 RUNNING과 heartbeat를 유지하고 나머지 96건은 대기열에 남는다. 완료 전 ACK하지 않는다. 대기 단계는 기존 WAITING_FOR_MODEL을 사용한다.
- 실패한 HTTP 왕복만 다시 보내므로 이미 완료한 FAQ 검색·도구 실행은 반복하지 않는다. HTTP 재전송 자체는 서버 계산을 반복할 수 있으나 저장은 같은 작업의 실행 토큰으로 한 번만 확정한다.

## 같은 100건 비교

합성 회원 100명 재로그인·비캐시 FAQ·실제 Qwen3-4B vLLM/BGE-M3·Worker/LLM 동시 실행 4·별도 API/Worker JVM 조건을 유지했다. DB 실행 4건·대기 96건과 실제 모델 요청 4개를 확인하고 chat vLLM만 SIGKILL(exit 137)로 종료했다. 약 15초 뒤 같은 컨테이너·이미지·캐시로 재기동했다. DB·Redis·embedding·API·Worker는 재시작하지 않았다.

| 항목 | 수정 전 | 수정 후 |
|---|---:|---:|
| 원래 100건 성공 / 최종 실패 | 0 / 100 | **100 / 0** |
| 작업 기록 유실 / 미완료 / 중복 답변 | 0 / 0 / 0 | **0 / 0 / 0** |
| 타임아웃 | 0 | **0** |
| 사용자 시도 횟수 / 원래 작업 실행 시작 | 1회씩 / 100회 | **1회씩 / 100회** |
| 모델 연결 실패 대기 후 HTTP 재전송 | 없음 | **${result.retryWaits}회 대기, 4개 원래 작업** |
| 모델 종료 → /health 첫 200 | ${sec(old.timingsMs.modelUnavailable)}초 | ${sec(t.modelUnavailable)}초 |
| 재기동 요청 → /health 첫 200 | ${sec(old.timingsMs.restartToReady)}초 | ${sec(t.restartToReady)}초 |
| 모델 준비 → 첫 자동 답변 저장 | 자동 복구 없음 | **${sec(t.readyToFirstAnswer)}초** |
| 모델 준비 → 원래 100건 답변 완료 | 자동 복구 없음 | **${sec(t.readyToAllAnswers)}초** |
| 장애 주입 → 원래 100건 최종 처리 | ${sec(old.timingsMs.killToOriginalAllTerminal)}초, 전부 실패 | **${sec(t.killToAllAnswers)}초, 전부 성공** |
| 모델 중단 중 상태 GET | ${old.apiDuringModelUnavailable.count}건 모두 200 | **${result.apiDuringModelUnavailable.count}건 모두 200** |
| 같은 구간 GET p95 / 최대 | ${old.apiDuringModelUnavailable.p95Ms} / ${old.apiDuringModelUnavailable.maxMs}ms | **${result.apiDuringModelUnavailable.p95Ms} / ${result.apiDuringModelUnavailable.maxMs}ms** |

두 실행의 모델 재초기화 시간은 달랐다. 모델 시작 시간의 단일 실행 편차를 코드 최적화 효과로 해석하지 않는다. 핵심 차이는 실패로 큐를 소진하던 동작이 원래 작업을 보존하고 자동으로 답변을 완료하는 동작으로 바뀐 것이다. 수정 전 별도 수동 재시도 1건은 원래 100건 성공에 포함하지 않는다.

## 검증 근거

- 독립 읽기 전용 SQL: 원래 작업·시도·회원·대화·답변 각 100개, 사용자 시도 횟수 전부 1, HTTP/DB 답변 해시 100/100 일치. 소유권·중복·누락·결과 참조 불일치 0. 최종 PEL과 전체 미완료 작업도 0이다.
- 장애 당시 4건은 실행 토큰과 저장된 실행 마감을 유지했다. 모든 RUNNING 표본에서 마감이 한 값으로 유지됐고 heartbeat가 갱신됐다. 최종 답변은 같은 100개 작업에서 생성됐으며 사용자 재시도 API를 호출하지 않았다.
- 새 vLLM 프로세스의 실제 성공 호출 ${modelSuccess}건, Worker 논리 LLM 성공 100건, 모델 복구 대기 지표 ${waits}회와 로그가 일치했다. 모델 누적 카운터는 재기동 구간을 분리해 해석했다.
- 회귀 테스트 **${tests.tests - tests.skipped}건 통과, ${tests.skipped}건 조건부 생략**, 실패·오류 0. 생략된 기존 Live 테스트 대신 이 실험은 실제 모델 100건으로 수행했다. 503 후 복구·영구 장애 기한 만료·대기 중 취소·4xx 제외·도구 1회 실행·DB 전체 기한·이전 Ollama/인증/채팅/조회 동작을 포함한다. bootJar 성공.
- 모델과 원래 unless-stopped 재시작 정책을 복원했다. 검증 JVM과 전용 DB·Redis를 정리하고 기존 서비스 4개·데이터 볼륨은 유지했다.

## 기존 코드에 미치는 범위

- LlmRecovery와 OpenAiCompatibleLlmClient: Worker가 설치한 스레드 범위에서만 vLLM HTTP 재시도를 수행하고 종료 시 해제한다. 다른 API와 Ollama의 기본 호출 방식은 유지한다.
- ChatJobWorker/ChatWorkerProperties: 재시도 대기를 기존 계산 Future·취소·실행 토큰·heartbeat에 연결한다. 설정은 CHAT_WORKER_MODEL_RETRY_BACKOFF(기본 5초) 한 개를 추가했다.
- ChatJobQueueRepository: 선점·넘겨받기의 저장 마감을 전체 기한과 비교해 짧은 쪽으로 정한다. 스키마·마이그레이션·API 응답 구조·사용자 재시도 횟수 규칙은 바꾸지 않았다.

[수정 전 결과](20261023-local-vllm-crash.md) · [비교 JSON](20261023-vllm-retry-comparison.json). 원본: ${process.argv[2]}. JAR·도구·증거 SHA-256을 JSON에 기록했다.
`);
console.log(JSON.stringify({ passed: true, summary: result.summary, retryWaits: waits, timingsMs: result.timingsMs,
  api: result.apiDuringModelUnavailable, testsPassed: tests.tests - tests.skipped, skipped: tests.skipped }));
