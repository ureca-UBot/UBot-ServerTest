import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { summarize, latency } from './model.mjs';
import { harnessSha256 } from '../lib/harness.mjs';

const directory = resolve(process.argv[2]); assert.ok(directory.startsWith(resolve('build') + '\\'));
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const read = name => json(join(directory, name));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const result = await read('report.json'), environment = await read('environment.json');
const audit = await read('independent-audit.json'), restored = await read('model-restored.json');
const cleanup = await read('infrastructure-cleanup.json'), probe = await read('recovery-probe.json');
const rows = await read('db-original-final.json'), responses = await read('api-original-final.json');
const submissions = await read('submissions.json'), reads = await read('api-job-reads.json');
const health = await read('api-health.json'), modelHealth = await read('model-health.json');
const previous = await json('tools/perf/postgres-crash/results/20261023-postgres-query-fix-comparison.json');
assert.equal(environment.jarSha256, previous.environment.jarSha256, '이전 장애 검증과 애플리케이션 JAR가 다릅니다.');
assert.equal(environment.jarSha256, await sha('build/libs/UBot-BE-0.0.1-SNAPSHOT.jar'));
assert.equal(environment.mode, 'baseline');
assert.equal(environment.harnessSha256, await harnessSha256('tools/perf/vllm-crash/run.mjs'));
assert.equal(environment.modelSha256, await sha('tools/perf/vllm-crash/model.mjs'));
assert.equal(environment.probeSha256, await sha('tools/perf/vllm-crash/probe.mjs'));
assert.equal(result.verificationPassed, true);
assert.deepEqual(result.summary, summarize(rows.rows, submissions, responses));
assert.equal(audit.original.expectedJobs, 100); assert.equal(audit.original.savedJobs, 100);
assert.equal(audit.original.uniqueJobs, 100); assert.equal(audit.original.uniqueMembers, 100);
assert.equal(audit.original.succeeded, result.summary.succeeded); assert.equal(audit.original.failed, result.summary.failed);
assert.equal(audit.original.timeouts, result.summary.timeouts); assert.equal(audit.original.storedAnswers, result.summary.savedAnswers);
for (const group of [audit.original, audit.probe]) {
  for (const key of ['statusMismatches', 'errorMismatches', 'ownershipMismatches', 'answerMismatches',
    'duplicateTurns', 'resultReferenceMismatches', 'attemptCountMismatches', 'missingOrUnfinished']) assert.equal(group[key], 0, key);
  assert.equal(group.clearedContexts, group.expectedJobs);
}
assert.equal(audit.probe.expectedJobs, 1); assert.equal(audit.probe.savedJobs, 1); assert.equal(audit.probe.succeeded, 1);
assert.equal(audit.probe.storedAnswers, 1); assert.equal(audit.sameConversationAndKey, true); assert.equal(audit.globalOutstanding, 0);
assert.ok(Math.abs(audit.original.allFinishedAtMs - Date.parse(result.killRequestedAt) - result.timingsMs.killToOriginalAllTerminal) < .01);
assert.ok(Math.abs(audit.probe.allFinishedAtMs - Date.parse(result.modelReadyAt) - result.timingsMs.readyToRecoveredAnswer) < .01);
assert.ok(restored.running); assert.deepEqual(restored.restartPolicy, environment.originalModel.restartPolicy);
assert.equal(restored.id, environment.originalModel.id); assert.equal(restored.image, environment.originalModel.image);
assert.notEqual(restored.startedAt, environment.originalModel.startedAt);
assert.equal(cleanup.scenarioProcessesRemaining, 0); assert.equal(cleanup.originalServicesAllRunning, true);
assert.ok(cleanup.isolatedContainers.every(c => !c.Running && c.ExitCode === 0));
assert.equal(cleanup.modelRestartPolicy, 'unless-stopped');
const processStart = text => text.match(/^process_start_time_seconds.*$/m)?.[0];
for (const role of ['api', 'worker']) {
  const before = processStart(await readFile(join(directory, `${role}-before.prom`), 'utf8'));
  const after = processStart(await readFile(join(directory, `${role}-after.prom`), 'utf8'));
  assert.ok(before); assert.equal(after, before);
}
const workerMetrics = await readFile(join(directory, 'worker-after.prom'), 'utf8');
const llmCalls = {};
for (const match of workerMetrics.matchAll(/^llm_requests_seconds_count\{kind="answer",outcome="([^"]+)",role="worker"\}\s+(\S+)$/gm)) {
  llmCalls[match[1]] = Number(match[2]);
}
assert.equal(Object.values(llmCalls).reduce((n, value) => n + value, 0), 101);
assert.equal(llmCalls.success, result.summary.succeeded + 1);
assert.equal(llmCalls.unavailable ?? 0, result.summary.errors['LLM-003'] ?? 0);
assert.equal(llmCalls.timeout ?? 0, result.summary.errors['LLM-004'] ?? 0);
const modelCount = text => [...text.matchAll(/^vllm:request_success_total\{[^\n]*finished_reason="stop"[^\n]*\}\s+(\S+)$/gm)]
  .reduce((n, match) => n + Number(match[1]), 0);
const modelCounters = {};
for (const [key, name] of [['before', 'vllm-before.prom'], ['immediatelyBeforeKill', 'vllm-immediately-before-kill.prom'],
  ['readyNewProcess', 'vllm-ready-before-probe.prom'], ['afterProbeNewProcess', 'vllm-after-probe.prom']]) {
  modelCounters[key] = modelCount(await readFile(join(directory, name), 'utf8'));
}
assert.equal(modelCounters.afterProbeNewProcess - modelCounters.readyNewProcess, 1);
assert.equal(modelCounters.immediatelyBeforeKill - modelCounters.before, result.summary.succeeded);
assert.ok(modelCounters.readyNewProcess < modelCounters.immediatelyBeforeKill, '재기동 후 지표 초기화 확인 실패');
const restartLog = await readFile(join(directory, 'vllm-restart.log'), 'utf8');
assert.match(restartLog, /Application startup complete/); assert.match(restartLog, /Capturing CUDA graphs/);
const tests = await readFile(join(directory, 'unit-tests.xml'), 'utf8');
assert.equal((tests.match(/<testcase /g) ?? []).length, 4); assert.doesNotMatch(tests, /<failure|<error/);
assert.match(tests, /<!-- pass 4 -->/); assert.match(tests, /<!-- fail 0 -->/);
const during = reads.filter(r => Date.parse(r.at) >= Date.parse(result.modelExitedAt) && Date.parse(r.completedAt) <= Date.parse(result.modelReadyAt));
assert.deepEqual(latency(during), result.apiDuringModelUnavailable);
assert.ok(during.length && during.every(r => r.httpStatus === 200 && r.elapsedMs < 2000));
assert.ok(health.length && health.every(r => r.httpStatus === 200 && r.healthStatus === 'UP'));
assert.ok(modelHealth.some(r => r.httpStatus === 0));
const evidence = [];
for (const name of ['environment.json', 'events.json', 'submissions.json', 'immediately-before-kill.json',
  'database-before-model-restart.json', 'db-original-final.json', 'db-original-after-probe.json', 'db-snapshots.json',
  'api-original-final.json', 'api-job-reads.json', 'api-health.json', 'model-health.json', 'security-checks.json',
  'recovery-probe.json', 'report.json', 'independent-audit.sql', 'independent-audit.json', 'vllm-restart.log',
  'vllm-before.prom', 'vllm-immediately-before-kill.prom', 'vllm-ready-before-probe.prom', 'vllm-after-probe.prom',
  'api-before.prom', 'api-after.prom', 'worker-before.prom', 'worker-after.prom', 'model-restored.json',
  'cleanup.json', 'infrastructure-cleanup.json', 'unit-tests.xml', 'api.log', 'worker.log']) {
  evidence.push({ name, sha256: await sha(join(directory, name)) });
}
const archive = { date: '2026-10-23', timezone: 'Asia/Seoul', scenario: 'vllm-process-crash-100-real-llm', environment,
  result, independentAudit: audit, recoveryProbe: { ...result.recoveryProbe, answer: probe.response.answer },
  modelCounters, workerLlmCalls: llmCalls, finalModelRestored: restored, cleanup,
  validation: { dataIntegrity: 'PASS', apiReadAvailability: 'PASS',
    original100AutomaticAnswerRecovery: result.summary.allOriginalJobsSucceeded ? 'PASS' : 'FAIL',
    separateManualRetry: 'PASS', unitTests: { tests: 4, failures: 0 }, applicationJarUnchanged: true },
  rawEvidenceDirectory: process.argv[2], evidence,
  limitations: ['SIGKILL·로컬 단일 실행이며 장시간 네트워크 무응답·GPU OOM을 함께 주입한 실험은 아니다.',
    '원래 100건과 별도 수동 재시도 1건을 분리한다. FAILED 보존은 답변 성공이나 자동 복구가 아니다.',
    'API health와 작업 상태 조회의 HTTP 200은 vLLM 가용성이나 답변 성공을 뜻하지 않는다.'] };
const serialized = JSON.stringify(archive, null, 2) + '\n';
assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
assert.doesNotMatch(serialized, /"(?:accessToken|refreshToken|password)"\s*:/);
const output = 'tools/perf/vllm-crash/results'; await mkdir(output, { recursive: true });
await writeFile(join(output, '20261023-local-vllm-crash.json'), serialized);
const s = result.summary, t = result.timingsMs, api = result.apiDuringModelUnavailable;
const sec = value => (value / 1000).toFixed(2);
const markdown = `# 로컬 vLLM 장애 검증 — 2026-10-23

**원래 100건은 모두 LLM-003으로 최종 실패했고, 모델 재기동 후에도 자동 재시도되지 않았다.** 작업 기록 유실·중복 답변·타임아웃은 0건이었다. 별도 사용자 재시도 1건은 실제 LLM 답변까지 성공했다. 데이터 일관성·조회 가용성 검증과 원래 작업의 자동 답변 복구 성공 여부를 구분한다.

## 실제 주입

- 합성 회원 100명으로 재로그인하고 질문을 한 번씩 보냈다. 모두 202·고유 jobId·QUEUED였다. 질문은 비캐시 FAQ “분실한 유심을 재발급받으려면 어떻게 하나요?”다.
- API와 Worker는 별도 JVM, Worker·LLM 동시 실행 4, JVM당 Xms512m/Xmx2g를 사용했다. 실제 Qwen3-4B vLLM과 BGE-M3 서버를 사용하며 모델 응답은 모의하지 않았다. 이전 DB 조회 수정 검증과 **동일한 JAR**다.
- 09:46:27.696 KST에 vLLM 실행 요청 4건·DB 실행 4건/대기 96건을 관측했다. 5ms 뒤 **ubot-feat-200-vllm-1**에 SIGKILL을 요청했고 exit 137을 확인했다. embedding·API·Worker·DB·Redis는 재시작하지 않았다.
- 자동 재시작을 잠시 막아 약 15초의 중단 구간을 확보하고 같은 컨테이너·이미지·모델 캐시로 재기동했다. 최종적으로 **unless-stopped 정책을 복원**하고 /health 200을 확인했다.

## 원래 100건의 결과

| 항목 | 결과 |
|---|---:|
| 접수 / 보존된 작업 | ${s.accepted} / ${s.savedJobs} |
| 답변 성공 | **${s.succeeded}** |
| 최종 실패 | **${s.failed} — LLM-003 ${s.errors['LLM-003'] ?? 0}건** |
| 타임아웃 / 취소 | ${s.timeouts} / ${s.cancelled} |
| 누락 / 미완료 | **${s.missingJobs} / ${s.unfinished}** |
| 저장 답변 / 중복 답변 | ${s.savedAnswers} / **${s.duplicateAnswers}** |
| 원래 작업의 실행 시작 / 재실행 | ${result.originalExecutionStarts} / ${result.repeatedOriginalExecutions.length} |
| 최종 Redis PEL / 전체 미완료 작업 | ${result.redisPending} / ${audit.globalOutstanding} |

유실은 접수된 작업 기록의 누락·미완료를 뜻한다. 이번에는 모든 기록이 남았지만 **답변 제공은 100건 모두 실패했다.** 별도 재시도의 성공 1건을 원래 100건에 더해 성공률을 높이지 않았다.

## API 응답

| 항목 | 결과 |
|---|---:|
| 모델 중단·초기화 중 상태 GET | **${api.count}/${api.count} HTTP 200** |
| 같은 구간 GET p50 / p95 / 최대 | ${api.p50Ms} / **${api.p95Ms}** / ${api.maxMs}ms |
| 클라이언트 조회 시간 초과 | ${api.clientFailures} |
| 전체 상태 GET | ${result.apiAll.count}건 모두 HTTP 200 |
| API health | ${result.apiHealth.count}건 모두 UP / HTTP 200 |
| 잘못된 JWT 서명 / 다른 회원 | 401 / 404 |

HTTP 200은 상태 조회의 성공이다. 장애 구간 표본 중 ${api.jobStatuses.FAILED ?? 0}건은 **data.status=FAILED, data.errorCode=LLM-003**이었다. API health가 계속 UP인 동안에도 실제 vLLM은 사용할 수 없었다. 원래 작업 100개의 최종 GET도 DB 상태·오류 코드와 모두 일치했다.

## 복구 시간

| 구간 | 측정 |
|---|---:|
| 종료 요청 → 컨테이너 종료 | ${t.forcedExit}ms |
| 종료 요청 → 원래 100건 전부 최종 실패 | **${sec(t.killToOriginalAllTerminal)}초** |
| 모델 종료 → /health 첫 200 | **${sec(t.modelUnavailable)}초** |
| 재기동 요청 → /health 첫 200 | **${sec(t.restartToReady)}초** |
| readiness → 별도 재시도 답변 DB 저장 | ${sec(t.readyToRecoveredAnswer)}초 |
| 별도 재시도 요청 → 답변 DB 저장 | **${sec(t.retryToRecoveredAnswer)}초** |
| 장애 주입 → 별도 재시도 답변 저장 | ${sec(t.killToRecoveredAnswer)}초 |

readiness 이후 원래 100건의 최종 상태 대조를 끝내고 재시도를 보냈다. readiness부터 답변까지의 시간에는 이 확인 절차가 포함된다. 실제 재시도 요청부터 답변 저장까지는 ${sec(t.retryToRecoveredAnswer)}초다. 모델 로딩·초기화·CUDA graph 준비 로그와 컨테이너 시작 시각 변경을 확인했다.

## 별도 재시도와 원인

실패 작업 ${probe.originalJobId}에 대해 기존 재시도 API를 **한 번** 호출했다. 같은 회원·대화·멱등키로 새 작업 ${probe.submission.jobId}(attemptCount=2)이 만들어졌고, 실제 LLM 답변 한 건이 저장됐다. 원래 작업 상태와 답변은 바뀌지 않았다. DB 답변과 HTTP 답변 해시도 일치한다.

현재 OpenAiCompatibleLlmClient는 연결 오류를 LLM-003으로 바꾸고, ChatJobCompletionService는 실패를 DB에 확정한다. Worker는 완료 커밋 뒤 Stream 메시지를 ACK한다. 이번에는 대기 96건도 서버가 없는 동안 빠르게 소비되어 실패로 확정됐으며, 모델 복구를 기다리는 자동 재시도가 없었다. 상태 응답의 retryable은 사용자가 재시도할 수 있다는 뜻이다.

vLLM 누적 성공 지표는 ${modelCounters.immediatelyBeforeKill}에서 재기동 후 ${modelCounters.readyNewProcess}로 초기화됐다. 재기동 전후 수치를 그대로 빼지 않고, 새 프로세스 readiness 이후 별도 재시도에서 성공 호출이 **1건 증가**했는지 확인했다. Worker 지표도 원래 unavailable ${llmCalls.unavailable ?? 0}건과 별도 success ${llmCalls.success}건을 구분한다.

## 검증·보존

- 독립 읽기 전용 SQL: 원래 100건과 별도 1건의 상태·오류 코드·소유권·답변 해시·중복·결과 참조·시도 횟수 불일치 0건. 같은 대화·멱등키 확인.
- 집계 단위 테스트 **4건 통과**. 명시적 실패와 유실, 타임아웃, 중복, HTTP 200과 작업 FAILED를 구분한다.
- 애플리케이션·스키마·기본 제한은 수정하지 않았다. 장애 도구와 문서만 추가했다. API·Worker 프로세스 시작 시각, DB 시작 시각·Redis run_id·embedding 시작 시각은 유지됐다.
- 생성한 JVM을 종료하고 전용 DB·Redis만 정지했다. 기존 개발 서비스 4개·모델 재시작 정책·모든 데이터 볼륨은 보존했다.

원본: ${process.argv[2]}. [JSON 결과](20261023-local-vllm-crash.json)에 JAR·도구·증거 SHA-256을 기록했다. 로컬 SIGKILL 단일 실행 결과이며, 긴 네트워크 무응답을 따로 주입한 타임아웃 실험은 아니다.
`;
await writeFile(join(output, '20261023-local-vllm-crash.md'), markdown);
console.log(JSON.stringify({ validation: archive.validation, summary: result.summary, api: result.apiDuringModelUnavailable,
  timingsMs: result.timingsMs, separateProbeSucceeded: true }));
