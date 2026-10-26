import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { request } from '../chat-burst/cli.mjs';
import { apiUrl, workerUrl, database, redis, question, jar, repo, timestamp, sha, harnessSha256, openRun, sql,
  jobRowsQuery, pending, startSpring, ready, metrics, forceKill as killOwned, killRemaining, healthLoop as watchHealth,
  assertPortsFree, modelList, loginMembers, submitQuestions } from '../lib/harness.mjs';

// 실제 로컬 모델과 기존 전용 테스트 DB만 사용함. DB 상태나 복구 시계를 수정하지 않음
const { config, directory, write, event } = await openRun();
const owned = [];
let jobIds = [];
let monitor = true;
const probes = [];
const snapshots = [];
let healthTask;

const jobQuery = () => jobRowsQuery(jobIds);
function snapshot() {
  const value = { at: timestamp(), rows: sql(jobQuery()) };
  assert.equal(value.rows.length, 100, '접수된 작업이 DB에서 사라졌습니다.');
  snapshots.push(value);
  return value;
}
const start = (role, name) => startSpring({ directory, owned, role, name });
const forceKill = child => killOwned(owned, child);
const healthLoop = (url, target) => watchHealth(url, target, () => monitor);

try {
  await assertPortsFree();
  const hash = sha(await readFile(join(repo, jar)));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const models = await modelList();
  const fixture = sql(`SELECT json_build_object('outstanding', (SELECT count(*) FROM chat_jobs
    WHERE execution_status IN ('QUEUED','RUNNING')), 'faqs', (SELECT json_agg(t) FROM
    (SELECT id, question, cacheable FROM faq ORDER BY id) t));`);
  assert.equal(fixture.outstanding, 0, '기존 미완료 작업이 있는 DB에서는 실행하지 않습니다.');
  const harnessHash = await harnessSha256(import.meta.url);
  await write('environment.json', { commit, jarSha256: hash, harnessSha256: harnessHash, apiUrl, workerUrl, models, fixture,
    concurrency: 4, heartbeatTimeoutMs: 60000, recoveryIntervalMs: 15000, reclaimIdleMs: 300000,
    queueTimeoutMs: 600000, executionTimeoutMs: 180000, maxDeliveries: 3, syntheticMembers: 100,
    question, llmMocked: false, database, redis });
  const api = start('api', 'api');
  await event('api-start-requested', { pid: api.pid });
  await ready(api, apiUrl);
  const apiMetrics = await metrics(apiUrl);
  assert.ok(apiMetrics.includes('role="api"'));
  assert.ok(!apiMetrics.includes('chat_worker_active{'), 'API에서 워커가 실행되고 있습니다.');
  await writeFile(join(directory, 'api-before.prom'), apiMetrics);
  await event('api-ready', { pid: api.pid });
  healthTask = healthLoop(apiUrl, probes);
  const accounts = await loginMembers(config);
  await event('real-member-login-completed', { count: 100 });
  // 한 회원당 질문 POST는 정확히 한 번. 장애 후에도 재접수/사용자 재시도 API를 호출하지 않음
  const submissions = await submitQuestions(accounts);
  await write('submissions.json', submissions);
  assert.ok(submissions.every(s => s.httpStatus === 202));
  jobIds = submissions.map(s => s.jobId);
  const accepted = snapshot();
  assert.ok(accepted.rows.every(r => r.status === 'QUEUED'));
  assert.ok(accepted.rows.every(r => r.userId === submissions.find(s => s.jobId === r.jobId).userId));
  await event('all-accepted-before-worker-start', { count: 100, statuses: { QUEUED: 100 } });
  await writeFile(join(directory, 'evidence.sql'), `BEGIN READ ONLY;\n${jobQuery()}\nCOMMIT;\n`);
  await writeFile(join(directory, 'vllm-before.prom'), await metrics('http://127.0.0.1:8000', '/metrics'));
  const worker = start('worker', 'worker-before-crash');
  await event('worker-start-requested', { pid: worker.pid });
  // HTTP 기동 대기 중에도 처리가 시작되므로 DB의 GENERATING을 직접 관찰함
  let before;
  let inflightModelRequests = 0;
  let inflightMetrics;
  let inflightObservedAt;
  for (let i = 0; i < 240; i++) {
    before = snapshot();
    if (before.rows.some(r => r.status === 'RUNNING' && r.phase === 'GENERATING')) {
      inflightMetrics = await metrics('http://127.0.0.1:8000', '/metrics');
      inflightObservedAt = timestamp();
      inflightModelRequests = [...inflightMetrics.matchAll(/^vllm:num_requests_running\{[^\n]+\}\s+([\d.eE+-]+)$/gm)]
        .reduce((sum, match) => sum + Number(match[1]), 0);
      if (inflightModelRequests > 0) break;
    }
    assert.equal(worker.exitCode, null);
    await wait(250);
  }
  assert.ok(before.rows.some(r => r.status === 'RUNNING' && r.phase === 'GENERATING'), '실제 LLM 생성 중인 작업을 찾지 못했습니다.');
  assert.ok(inflightModelRequests > 0, '모델 서버의 실제 실행 중 요청을 확인하지 못했습니다.');
  await write('immediately-before-kill.json', before);
  await writeFile(join(directory, 'vllm-before-force-kill.prom'), inflightMetrics);
  const killRequestedAt = timestamp();
  const killed = await forceKill(worker);
  const afterKill = snapshot();
  const interrupted = afterKill.rows.filter(r => r.status === 'RUNNING');
  assert.ok(interrupted.length > 0);
  await event('worker-force-killed', { pid: worker.pid, killRequestedAt, exited: killed,
    running: interrupted.length, inflightModelRequests, inflightObservedAt,
    queued: afterKill.rows.filter(r => r.status === 'QUEUED').length,
    succeeded: afterKill.rows.filter(r => r.status === 'SUCCEEDED').length, pending: pending() });
  await write('immediately-after-kill.json', afterKill);
  for (let i = 0; i < 5; i++) {
    const r = await request(apiUrl, 'GET', `/chat/jobs/${interrupted[0].jobId}`, undefined,
      accounts[submissions.findIndex(s => s.jobId === interrupted[0].jobId)].token);
    assert.equal(r.status, 200);
    await event('api-job-read-while-worker-dead', { jobId: interrupted[0].jobId, httpStatus: r.status, status: r.body.data.status });
    await wait(1000);
  }
  await writeFile(join(directory, 'vllm-after-kill.prom'), await metrics('http://127.0.0.1:8000', '/metrics'));
  const restartRequestedAt = timestamp();
  const replacement = start('worker', 'worker-after-crash');
  await event('worker-restart-requested', { pid: replacement.pid, previousPid: worker.pid });
  await ready(replacement, workerUrl);
  const workerReadyAt = timestamp();
  await event('replacement-worker-ready', { pid: replacement.pid });
  let final;
  let lastProgress = 0;
  while (Date.now() - Date.parse(restartRequestedAt) < 12 * 60 * 1000) {
    final = snapshot();
    if (final.rows.every(r => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(r.status))) break;
    if (Date.now() - lastProgress > 15000) {
      await event('recovery-progress', { statuses: final.rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}) });
      lastProgress = Date.now();
    }
    assert.equal(replacement.exitCode, null);
    assert.equal(api.exitCode, null);
    await wait(1000);
  }
  await write('db-final.json', final);
  await write('db-snapshots.json', snapshots);
  const answers = [];
  for (let offset = 0; offset < 100; offset += 5) {
    answers.push(...await Promise.all(submissions.slice(offset, offset + 5).map(async (s, localIndex) => {
      const r = await request(apiUrl, 'GET', `/chat/jobs/${s.jobId}`, undefined, accounts[offset + localIndex].token);
      return { caseId: s.caseId, jobId: s.jobId, httpStatus: r.status, observedAt: timestamp(), ...r.body?.data };
    })));
    await wait(250);
  }
  await write('api-final.json', answers);
  await wait(1000); // 성공 커밋 직후의 ACK까지 관찰함
  const finalPending = pending();
  await write('redis-pending-final.json', finalPending);
  const [apiAfter, workerAfter, modelAfter] = await Promise.all([metrics(apiUrl), metrics(workerUrl), metrics('http://127.0.0.1:8000', '/metrics')]);
  await writeFile(join(directory, 'api-after.prom'), apiAfter);
  await writeFile(join(directory, 'worker-after.prom'), workerAfter);
  await writeFile(join(directory, 'vllm-after.prom'), modelAfter);
  monitor = false;
  await healthTask;
  await write('api-health.json', probes);
  const recovered = interrupted.map(old => {
    const current = final.rows.find(r => r.jobId === old.jobId);
    return { jobId: old.jobId, beforeStartedAtMs: old.startedAtMs, beforeHeartbeatAtMs: old.heartbeatAtMs,
      recoveredStartedAtMs: current.startedAtMs, finishedAtMs: current.finishedAtMs, status: current.status,
      leaseChanged: current.startedAtMs > old.startedAtMs };
  });
  const allFinishedAtMs = Math.max(...final.rows.map(r => r.finishedAtMs ?? 0));
  const failed = final.rows.filter(r => r.status !== 'SUCCEEDED');
  const duplicateTurns = final.rows.filter(r => r.turnRows > 1 || r.duplicateSubQuestions > 0);
  const workerLog = await readFile(join(directory, 'worker-after-crash.log'), 'utf8');
  const startedCounts = {};
  // 커밋 뒤에 찍히는 저장 완료 로그만 셈. 트랜잭션 안의 완료 로그는 커밋 실패 후 재실행 때 두 번 남을 수 있음
  // 참고용이며 중복 판정은 DB 저장본(duplicateTurns·savedTurns)으로 함
  const completedCounts = {};
  const allLlmRoutes = new Set();
  for (const name of ['worker-before-crash', 'worker-after-crash']) {
    const log = await readFile(join(directory, `${name}.log`), 'utf8');
    for (const match of log.matchAll(/답변 작업을 시작합니다: 작업ID=(\d+)/g)) {
      if (jobIds.includes(Number(match[1]))) startedCounts[match[1]] = (startedCounts[match[1]] ?? 0) + 1;
    }
    for (const match of log.matchAll(/답변 작업의 결과 저장을 마쳤습니다: 작업ID=(\d+)/g)) {
      if (jobIds.includes(Number(match[1]))) completedCounts[match[1]] = (completedCounts[match[1]] ?? 0) + 1;
    }
    for (const match of log.matchAll(/CHAT route: attemptId=(\d+), source=LLM/g)) allLlmRoutes.add(Number(match[1]));
  }
  const llmRoutes = new Set([...workerLog.matchAll(/CHAT route: attemptId=(\d+), source=LLM/g)].map(m => Number(m[1])));
  const report = { verifiedAt: timestamp(), accepted: 100, uniqueJobIds: new Set(jobIds).size,
    killRequestedAt, processExitedAt: killed.at, restartRequestedAt, workerReadyAt,
    inflightModelRequests, inflightObservedAt,
    interrupted: interrupted.length, queuedAtKill: afterKill.rows.filter(r => r.status === 'QUEUED').length,
    succeededAtKill: afterKill.rows.filter(r => r.status === 'SUCCEEDED').length,
    succeeded: final.rows.filter(r => r.status === 'SUCCEEDED').length, failed, recovered,
    missingJobs: 100 - final.rows.length, unfinished: final.rows.filter(r => !r.finishedAtMs).length,
    duplicateTurns: duplicateTurns.length, savedTurns: final.rows.reduce((n, r) => n + r.turnRows, 0),
    emptyAnswers: final.rows.reduce((n, r) => n + r.emptyAnswers, 0),
    apiAnswers: answers.filter(a => a.httpStatus === 200 && a.status === 'SUCCEEDED' && a.answer?.trim()).length,
    repeatedExecutions: Object.entries(startedCounts).filter(([, count]) => count > 1),
    executionStarts: Object.values(startedCounts).reduce((a, n) => a + n, 0),
    replacementLlmRouteJobs: final.rows.filter(r => llmRoutes.has(r.attemptId)).length,
    llmRouteJobs: final.rows.filter(r => allLlmRoutes.has(r.attemptId)).length,
    duplicateCommittedLogs: Object.values(completedCounts).filter(count => count > 1).length,
    uniqueCommittedLogs: Object.keys(completedCounts).length,
    apiProcessStartUnchanged: Boolean(apiMetrics.match(/^process_start_time_seconds.*$/m)?.[0]) &&
      apiMetrics.match(/^process_start_time_seconds.*$/m)?.[0] === apiAfter.match(/^process_start_time_seconds.*$/m)?.[0],
    apiProbeCount: probes.length, apiProbeFailures: probes.filter(p => p.httpStatus !== 200 || p.status !== 'UP').length,
    apiPid: api.pid, oldWorkerPid: worker.pid, replacementWorkerPid: replacement.pid,
    redisPending: finalPending[0],
    timingsMs: { forcedExit: Date.parse(killed.at) - Date.parse(killRequestedAt),
      restartStartup: Date.parse(workerReadyAt) - Date.parse(restartRequestedAt),
      killToReplacementReady: Date.parse(workerReadyAt) - Date.parse(killRequestedAt),
      killToFirstInterruptedRestart: Math.min(...recovered.map(r => r.recoveredStartedAtMs)) - Date.parse(killRequestedAt),
      killToFirstInterruptedAnswer: Math.min(...recovered.map(r => r.finishedAtMs ?? Infinity)) - Date.parse(killRequestedAt),
      killToAllAnswers: allFinishedAtMs - Date.parse(killRequestedAt),
      restartToAllAnswers: allFinishedAtMs - Date.parse(restartRequestedAt),
      firstSubmissionToAllAnswers: allFinishedAtMs - Math.min(...submissions.map(s => Date.parse(s.startedAt))) },
    answerSamples: answers.filter(a => interrupted.some(r => r.jobId === a.jobId)).slice(0, 3)
      .map(({ jobId, answer, status }) => ({ jobId, answer, status })) };
  report.passed = report.succeeded === 100 && report.missingJobs === 0 && report.unfinished === 0 &&
    report.duplicateTurns === 0 && report.savedTurns === 100 && report.emptyAnswers === 0 && report.apiAnswers === 100 &&
    report.apiProbeFailures === 0 && report.redisPending === 0 && report.llmRouteJobs === 100 &&
    report.apiProcessStartUnchanged &&
    recovered.every(r => r.leaseChanged && r.status === 'SUCCEEDED');
  await write('report.json', report);
  await event('verification-completed', { passed: report.passed, succeeded: report.succeeded,
    interrupted: report.interrupted, duplicateTurns: report.duplicateTurns, timingsMs: report.timingsMs });
  assert.ok(report.passed, '검증 실패: report.json을 확인하세요.');
} catch (error) {
  await write('failure.json', { at: timestamp(), message: error.message });
  if (jobIds.length === 100) {
    try { await write('db-at-failure.json', snapshot()); } catch {
      // 원래 실패를 보존함
    }
  }
  throw error;
} finally {
  monitor = false;
  if (healthTask) await healthTask;
  await write('api-health.json', probes);
  await write('db-snapshots.json', snapshots);
  await killRemaining(owned);
  await write('cleanup.json', { at: timestamp(), processes: owned.map(p => ({ pid: p.pid, exitCode: p.exitCode, signal: p.signalCode })),
    testDataRetained: true });
}
