import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { request } from '../chat-burst/cli.mjs';
import { summarize, latency } from './model.mjs';
import { apiUrl, workerUrl, modelUrl, database, redis, question, jar, repo, timestamp, sha, harnessSha256, openRun,
  docker, sql, pending, startSpring, ready, metrics, killRemaining, assertPortsFree, modelList, loginMembers,
  submitQuestions } from '../lib/harness.mjs';

// baseline: 수정 전 JAR 기준 실험. 모델 장애로 실패한 원래 작업은 그대로 두고 사용자 재시도 1건으로 응답 복구를 확인함
// auto-retry: Worker 자동 재시도 검증. 사용자 재시도 없이 원래 100건이 모두 성공해야 함
const MODES = ['baseline', 'auto-retry'];
const mode = process.argv[4] === '--mode' ? process.argv[5] : undefined;
assert.ok(MODES.includes(mode), `--mode는 ${MODES.join(' 또는 ')}여야 합니다.`);
const autoRetry = mode === 'auto-retry';
const { config, directory, write, event } = await openRun();
const snapshots = [], modelProbes = [], jobReads = [], apiHealth = [], securityChecks = [];
const model = 'ubot-feat-200-vllm-1', embedding = 'ubot-feat-200-vllm-embedding-1';
const owned = [];
let ids = [], observer, observerDone, originalModel, policyChanged = false, stopProbe = false;
let modelReadyAt, killRequestedAt;
function state(container) { return JSON.parse(docker(['inspect', '--format', '{{json .State}}', container])); }
function identity(container) {
  const current = state(container);
  return { running: current.Running, startedAt: current.StartedAt,
    image: docker(['inspect', '--format', '{{.Image}}', container]),
    id: docker(['inspect', '--format', '{{.Id}}', container]),
    restartPolicy: JSON.parse(docker(['inspect', '--format', '{{json .HostConfig.RestartPolicy}}', container])) };
}
function jobQuery(jobIds) {
  assert.ok(jobIds.length && jobIds.every(id => Number.isSafeInteger(id) && id > 0));
  return `SELECT coalesce(json_agg(t ORDER BY t."jobId"),'[]'::json) FROM (
    SELECT j.job_id AS "jobId", j.attempt_id AS "attemptId", j.execution_status AS status,
      j.phase, a.status AS "attemptStatus", a.error_code AS "errorCode", a.attempt_count AS "attemptCount",
      a.user_id AS "userId", a.conversation_id AS "conversationId",
      extract(epoch FROM j.created_at AT TIME ZONE 'Asia/Seoul')*1000 AS "createdAtMs",
      extract(epoch FROM j.started_at AT TIME ZONE 'Asia/Seoul')*1000 AS "startedAtMs",
      extract(epoch FROM j.deadline_at AT TIME ZONE 'Asia/Seoul')*1000 AS "deadlineAtMs",
      extract(epoch FROM j.heartbeat_at AT TIME ZONE 'Asia/Seoul')*1000 AS "heartbeatAtMs",
      extract(epoch FROM j.finished_at AT TIME ZONE 'Asia/Seoul')*1000 AS "finishedAtMs",
      (SELECT count(*) FROM question_log q WHERE q.attempt_id=j.attempt_id AND q.sub_question_index=1) AS "turnRows",
      (SELECT count(*) FROM (SELECT sub_question_index FROM question_log q WHERE q.attempt_id=j.attempt_id
        GROUP BY sub_question_index HAVING count(*)>1) d) AS "duplicateSubQuestions",
      (SELECT md5(q.llm_question) FROM question_log q WHERE q.attempt_id=j.attempt_id AND q.sub_question_index=1 LIMIT 1) AS "answerMd5",
      j.result_payload AS "resultPayload", j.request_context IS NULL AS "contextCleared"
    FROM chat_jobs j JOIN answer_attempts_history a ON a.attempt_id=j.attempt_id
    WHERE j.job_id IN (${jobIds.join(',')})
  ) t;`;
}
function snapshot() {
  const value = { at: timestamp(), rows: sql(jobQuery(ids)) };
  assert.equal(value.rows.length, 100); snapshots.push(value); return value;
}
function terminal(rows) { return rows.every(r => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(r.status)); }
function counts(rows) { return rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}); }
function dependencies() {
  return { databaseStartedAt: state(database).StartedAt, embeddingStartedAt: state(embedding).StartedAt,
    redisRunId: docker(['exec', redis, 'redis-cli', 'INFO', 'server']).match(/^run_id:(.+)$/m)?.[1].trim() };
}
const start = role => startSpring({ directory, owned, role, name: role, consumer: 'vllm-crash-worker' });
// 지표를 결과 폴더에 저장하고 본문을 돌려줌
async function saveMetrics(url, path, name) {
  const text = await metrics(url, path); await writeFile(join(directory, name), text); return text;
}
async function modelHealth() {
  const started = Date.now(); const sample = { at: timestamp() };
  try { sample.httpStatus = (await fetch(modelUrl + '/health', { signal: AbortSignal.timeout(1000) })).status; }
  catch { sample.httpStatus = 0; }
  sample.completedAt = timestamp(); sample.elapsedMs = Date.now() - started;
  modelProbes.push(sample); return sample;
}
async function restoreReady() {
  for (let i = 0; i < 600; i++) {
    const sample = await modelHealth(); if (sample.httpStatus === 200) return sample.completedAt;
    await wait(1000);
  }
  throw Error('vLLM 모델 재기동 준비가 10분 안에 끝나지 않았습니다.');
}
function observe(submissions, accounts) {
  observer = new Worker(new URL('./probe.mjs', import.meta.url), { workerData: { apiUrl,
    watched: submissions.slice(0, 2).map((s, i) => ({ jobId: s.jobId, token: accounts[i].token })), foreign: { token: accounts[2].token } } });
  observerDone = new Promise((resolve, reject) => {
    observer.on('message', ({ kind, value }) => {
      if (kind === 'job') jobReads.push(value); if (kind === 'health') apiHealth.push(value);
      if (kind === 'security') securityChecks.push(value); if (kind === 'done') resolve();
    });
    observer.on('error', reject); observer.on('exit', code => { if (code !== 0) reject(Error(`관측 스레드 종료: ${code}`)); });
  });
}
async function fetchAnswers(submissions, accounts) {
  const result = [];
  for (let offset = 0; offset < submissions.length; offset += 5) {
    result.push(...await Promise.all(submissions.slice(offset, offset + 5).map(async (s, index) => {
      const r = await request(apiUrl, 'GET', `/chat/jobs/${s.jobId}`, undefined, accounts[offset + index].token, 2000);
      return { caseId: s.caseId, jobId: s.jobId, httpStatus: r.status, at: timestamp(), ...r.body?.data };
    })));
    await wait(100);
  }
  return result;
}
// baseline 전용. 원래 100건의 자동 처리 결과를 확정한 뒤, 별도 재시도 1건으로 실제 응답 복구를 확인함
async function manualRetryProbe(current, submissions, accounts, responses) {
  const failed = current.rows.find(r => r.status === 'FAILED');
  assert.ok(failed, '별도 실패 재시도 확인에 사용할 작업이 없습니다.');
  const index = submissions.findIndex(s => s.jobId === failed.jobId);
  assert.equal(responses[index].retryable, true);
  const startedAt = timestamp();
  const retryResponse = await fetch(apiUrl + '/chat/questions/retries', { method: 'POST',
    headers: { Authorization: `Bearer ${accounts[index].token}`, 'Idempotency-Key': submissions[index].idempotencyKey },
    signal: AbortSignal.timeout(30000) });
  assert.equal(retryResponse.status, 202); const retry = (await retryResponse.json()).data;
  assert.ok(Number.isSafeInteger(retry.jobId) && !ids.includes(retry.jobId)); assert.equal(retry.attemptCount, 2);
  let result;
  for (let i = 0; i < 200; i++) {
    const response = await request(apiUrl, 'GET', `/chat/jobs/${retry.jobId}`, undefined, accounts[index].token, 2000);
    assert.equal(response.status, 200); result = response.body.data;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.status)) break;
    await wait(1000);
  }
  const rows = sql(jobQuery([retry.jobId]));
  await write('recovery-probe.json', { originalJobId: failed.jobId, userId: accounts[index].userId,
    startedAt, observedAt: timestamp(), httpStatus: retryResponse.status, submission: retry, response: result, rows });
  assert.equal(result.status, 'SUCCEEDED'); assert.ok(result.answer?.trim());
  assert.equal(rows[0].userId, failed.userId); assert.equal(rows[0].conversationId, failed.conversationId);
  assert.equal(rows[0].answerMd5, createHash('md5').update(result.answer).digest('hex'));
  const finalOriginal = snapshot();
  assert.deepEqual(finalOriginal.rows, current.rows, '별도 재시도 중 원래 작업의 결과가 바뀌었습니다.');
  await write('db-original-after-probe.json', finalOriginal);
  return { failed, retry, result, rows, startedAt };
}

try {
  await assertPortsFree();
  originalModel = identity(model); assert.equal(originalModel.running, true);
  assert.equal(originalModel.restartPolicy.Name, 'unless-stopped');
  assert.equal((await modelHealth()).httpStatus, 200);
  const models = await modelList();
  const beforeDependencies = dependencies();
  const fixture = sql(`SELECT json_build_object('outstanding',(SELECT count(*) FROM chat_jobs WHERE execution_status IN ('QUEUED','RUNNING')),
    'cacheable',(SELECT cacheable FROM faq WHERE question='${question}'));`);
  assert.equal(fixture.outstanding, 0); assert.equal(fixture.cacheable, false);
  await write('environment.json', { scenario: autoRetry ? 'vllm-process-crash-auto-retry' : 'vllm-process-crash', mode,
    jarSha256: sha(await readFile(join(repo, jar))),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    harnessSha256: await harnessSha256(import.meta.url),
    modelSha256: sha(await readFile(new URL('./model.mjs', import.meta.url))), probeSha256: sha(await readFile(new URL('./probe.mjs', import.meta.url))),
    apiUrl, workerUrl, model, database, redis, question, syntheticMembers: 100, concurrency: 4,
    heartbeatTimeoutMs: 60000, recoveryIntervalMs: 15000, reclaimIdleMs: 300000, queueTimeoutMs: 600000,
    executionTimeoutMs: 180000, ...(autoRetry ? { totalTimeoutMs: 600000, modelRetryBackoffMs: 5000, manualRetryRequests: 0 } : {}),
    downTargetMs: 15000, llmMocked: false, originalModel, beforeDependencies,
    models: models.map(m => m.data.map(({ id, root }) => ({ id, root }))) });
  const api = start('api'); await event('api-start-requested', { pid: api.pid }); await ready(api, apiUrl);
  const apiBefore = await saveMetrics(apiUrl, '/actuator/prometheus', 'api-before.prom');
  const accounts = await loginMembers(config);
  await event('real-member-login-completed', { count: 100 });
  const submissions = await submitQuestions(accounts);
  await write('submissions.json', submissions); assert.ok(submissions.every(s => s.httpStatus === 202));
  ids = submissions.map(s => s.jobId); assert.equal(new Set(ids).size, 100);
  assert.ok(snapshot().rows.every(r => r.status === 'QUEUED'));
  await event('all-accepted-before-worker-start', { count: 100 });
  observe(submissions, accounts);
  await saveMetrics(modelUrl, '/metrics', 'vllm-before.prom');
  // 같은 컨테이너를 수동 재기동할 때까지 자동 재시작만 잠시 막고 finally에서 원복함
  policyChanged = true; docker(['update', '--restart=no', model]);
  const worker = start('worker'); await event('worker-start-requested', { pid: worker.pid }); await ready(worker, workerUrl);
  const workerBefore = await saveMetrics(workerUrl, '/actuator/prometheus', 'worker-before.prom');
  let before, modelRunning = 0, observedAt;
  for (let i = 0; i < 240; i++) {
    before = snapshot();
    if (before.rows.some(r => r.status === 'RUNNING' && r.phase === 'GENERATING')) {
      const text = await saveMetrics(modelUrl, '/metrics', 'vllm-immediately-before-kill.prom'); observedAt = timestamp();
      modelRunning = [...text.matchAll(/^vllm:num_requests_running\{[^\n]+\}\s+([\d.eE+-]+)$/gm)].reduce((n, m) => n + Number(m[1]), 0);
      if (modelRunning > 0) break;
    }
    await wait(200);
  }
  assert.ok(modelRunning > 0); await write('immediately-before-kill.json', before);
  killRequestedAt = timestamp(); assert.equal(model, 'ubot-feat-200-vllm-1');
  docker(['kill', '--signal', 'KILL', model]); const killed = state(model);
  assert.equal(killed.Running, false); assert.equal(killed.ExitCode, 137);
  await event('vllm-force-killed', { killRequestedAt, exitedAt: killed.FinishedAt, exitCode: killed.ExitCode,
    modelRunning, observedAt, databaseStatuses: counts(before.rows) });
  observer.postMessage('check-security');
  let current;
  while (Date.now() - Date.parse(killed.FinishedAt) < 15000) {
    current = snapshot(); await modelHealth(); await wait(1000);
  }
  await write('database-before-model-restart.json', current);
  const restartRequestedAt = timestamp(); docker(['start', model]);
  await event('vllm-restart-requested', { restartRequestedAt, statuses: counts(current.rows) });
  let lastProgress = 0;
  for (let i = 0; i < 600; i++) {
    const sample = await modelHealth(); current = snapshot();
    assert.equal(api.exitCode, null); assert.equal(worker.exitCode, null);
    if (sample.httpStatus === 200) { modelReadyAt = sample.completedAt; break; }
    if (Date.now() - lastProgress > 15000) {
      await event('model-startup-progress', { statuses: counts(current.rows), modelHttpStatus: sample.httpStatus }); lastProgress = Date.now();
    }
    await wait(1000);
  }
  assert.ok(modelReadyAt, 'vLLM 재기동 준비 시간 초과');
  await event('vllm-ready', { modelReadyAt, statuses: counts(current.rows) });
  const afterModel = identity(model);
  const modelsAfter = await (await fetch(modelUrl + '/v1/models')).json();
  assert.deepEqual(modelsAfter.data.map(({ id, root }) => ({ id, root })), models[0].data.map(({ id, root }) => ({ id, root })));
  await saveMetrics(modelUrl, '/metrics', autoRetry ? 'vllm-ready.prom' : 'vllm-ready-before-probe.prom');
  for (let i = 0; i < 300 && !terminal(current.rows); i++) {
    await wait(1000); current = snapshot();
    if (i % 15 === 0) await event('answer-recovery-progress', { statuses: counts(current.rows) });
  }
  await write('db-original-final.json', current);
  const responses = await fetchAnswers(submissions, accounts); await write('api-original-final.json', responses);
  const summary = summarize(current.rows, submissions, responses);
  await event('original-100-terminal', summary);
  let probe;
  if (autoRetry) {
    // 사용자 재시도·새 작업 없이 원래 100건만 검증함
    await write('api-final.json', responses);
    await write('db-final.json', current);
  } else {
    probe = await manualRetryProbe(current, submissions, accounts, responses);
  }
  await wait(1000); const finalPending = pending(); await write('redis-pending-final.json', finalPending);
  const apiAfter = await saveMetrics(apiUrl, '/actuator/prometheus', 'api-after.prom');
  const workerAfter = await saveMetrics(workerUrl, '/actuator/prometheus', 'worker-after.prom');
  await saveMetrics(modelUrl, '/metrics', autoRetry ? 'vllm-after-recovery.prom' : 'vllm-after-probe.prom');
  observer.postMessage('stop'); await observerDone; stopProbe = true;
  const afterDependencies = dependencies();
  const log = await readFile(join(directory, 'worker.log'), 'utf8');
  const starts = [...log.matchAll(/답변 작업을 시작합니다: 작업ID=(\d+)/g)].map(m => Number(m[1])).filter(id => ids.includes(id));
  const routes = new Set([...log.matchAll(/CHAT route: attemptId=(\d+), source=LLM/g)].map(m => Number(m[1])));
  const source = text => text.match(/^process_start_time_seconds.*$/m)?.[0];
  const during = jobReads.filter(r => Date.parse(r.at) >= Date.parse(killed.FinishedAt) && Date.parse(r.completedAt) <= Date.parse(modelReadyAt));
  const allFinished = Math.max(...current.rows.map(r => r.finishedAtMs ?? 0));
  const report = { verifiedAt: timestamp(), mode, summary, killRequestedAt, modelExitedAt: killed.FinishedAt,
    restartRequestedAt, modelReadyAt, beforeStatuses: counts(before.rows), modelRunning, observedAt,
    apiPid: api.pid, workerPid: worker.pid, originalModel, afterModel, beforeDependencies, afterDependencies,
    processStartUnchanged: source(apiBefore) === source(apiAfter) && source(workerBefore) === source(workerAfter),
    dependenciesUnchanged: JSON.stringify(beforeDependencies) === JSON.stringify(afterDependencies),
    modelRestartConfirmed: originalModel.startedAt !== afterModel.startedAt && originalModel.id === afterModel.id && originalModel.image === afterModel.image,
    originalLlmRoutes: current.rows.filter(r => routes.has(r.attemptId)).length, originalExecutionStarts: starts.length,
    repeatedOriginalExecutions: ids.filter(id => starts.filter(got => got === id).length > 1),
    apiDuringModelUnavailable: latency(during), apiAll: latency(jobReads), apiHealth: latency(apiHealth),
    securityChecks, redisPending: finalPending[0],
    timingsMs: { forcedExit: Date.parse(killed.FinishedAt) - Date.parse(killRequestedAt),
      modelUnavailable: Date.parse(modelReadyAt) - Date.parse(killed.FinishedAt),
      restartToReady: Date.parse(modelReadyAt) - Date.parse(restartRequestedAt),
      killToOriginalAllTerminal: allFinished - Date.parse(killRequestedAt),
      firstSubmissionToOriginalAllTerminal: allFinished - Math.min(...submissions.map(s => Date.parse(s.startedAt))) } };
  let modePassed;
  if (autoRetry) {
    const firstFinished = Math.min(...current.rows.filter(r => r.status === 'SUCCEEDED').map(r => r.finishedAtMs));
    // 계산 스레드 로그라 작업ID는 줄 앞 [작업ID=… 시도ID=…]에 있음(logging.pattern.correlation)
    const retryWaits = [...log.matchAll(/\[작업ID=(\d+) 시도ID=\d*\] [^\n]*?모델 연결 실패로 복구를 기다립니다/g)].map(m => Number(m[1]));
    const inFlight = before.rows.filter(r => r.status === 'RUNNING');
    Object.assign(report, { manualRetryRequests: 0, retryWaits: retryWaits.length, retryWaitJobIds: [...new Set(retryWaits)],
      userAttemptCountUnchanged: current.rows.every(r => r.attemptCount === 1),
      queuedAtKillIds: before.rows.filter(r => r.status === 'QUEUED').map(r => r.jobId),
      inFlight: inFlight.map(row => ({ jobId: row.jobId, startedAtMs: row.startedAtMs,
        finalStartedAtMs: current.rows.find(r => r.jobId === row.jobId).startedAtMs })) });
    Object.assign(report.timingsMs, {
      readyToFirstAnswer: firstFinished - Date.parse(modelReadyAt),
      readyToAllAnswers: allFinished - Date.parse(modelReadyAt),
      killToFirstAnswer: firstFinished - Date.parse(killRequestedAt),
      killToAllAnswers: allFinished - Date.parse(killRequestedAt) });
    modePassed = summary.succeeded === 100 && summary.failed === 0 && summary.timeouts === 0 && retryWaits.length > 0 &&
      report.userAttemptCountUnchanged && report.inFlight.every(r => r.startedAtMs === r.finalStartedAtMs);
  } else {
    Object.assign(report, { originalJobsStableAfterManualRetry: true, recoveryProbe: { jobId: probe.retry.jobId,
      sourceJobId: probe.failed.jobId, succeeded: probe.result.status === 'SUCCEEDED', attemptCount: probe.retry.attemptCount } });
    Object.assign(report.timingsMs, {
      readyToRecoveredAnswer: probe.rows[0].finishedAtMs - Date.parse(modelReadyAt),
      retryToRecoveredAnswer: probe.rows[0].finishedAtMs - Date.parse(probe.startedAt),
      killToRecoveredAnswer: probe.rows[0].finishedAtMs - Date.parse(killRequestedAt) });
    modePassed = true;
  }
  report.verificationPassed = summary.missingJobs === 0 && summary.unfinished === 0 && summary.duplicateAnswers === 0 &&
    summary.failedWithAnswer === 0 && summary.successWithoutAnswer === 0 && summary.ownershipMismatches === 0 && summary.apiMismatches === 0 &&
    summary.apiMissing === 0 && report.processStartUnchanged && report.dependenciesUnchanged && report.modelRestartConfirmed &&
    report.originalLlmRoutes === 100 && report.originalExecutionStarts === 100 && report.repeatedOriginalExecutions.length === 0 &&
    during.length > 0 && during.every(r => r.httpStatus === 200 && r.elapsedMs < 2000) &&
    apiHealth.every(r => r.httpStatus === 200 && r.healthStatus === 'UP') &&
    securityChecks.length === 2 && securityChecks.every(r => r.httpStatus === r.expectedStatus) && finalPending[0] === 0 && modePassed;
  await write('report.json', report);
  await event('verification-completed', { verificationPassed: report.verificationPassed, summary, timingsMs: report.timingsMs });
  assert.ok(report.verificationPassed, '일관성 검증 실패: report.json 확인');
} catch (error) {
  await write('failure.json', { at: timestamp(), message: error.message }); throw error;
} finally {
  try {
    if (policyChanged) {
      if (!state(model).Running) docker(['start', model]);
      await restoreReady(); docker(['update', `--restart=${originalModel.restartPolicy.Name}`, model]);
      await write('model-restored.json', identity(model));
    }
  } finally {
    if (observer && !stopProbe) { observer.postMessage('stop'); await observerDone; }
    await write('api-job-reads.json', jobReads); await write('api-health.json', apiHealth);
    await write('security-checks.json', securityChecks); await write('model-health.json', modelProbes);
    await write('db-snapshots.json', snapshots);
    await killRemaining(owned);
    await write('cleanup.json', { at: timestamp(), processes: owned.map(p => ({ pid: p.pid, exitCode: p.exitCode, signal: p.signalCode })),
      testDataRetained: true });
  }
}
