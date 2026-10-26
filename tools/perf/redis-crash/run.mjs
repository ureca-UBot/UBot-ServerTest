import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { request } from '../chat-burst/cli.mjs';
import { stateAtFault } from './analysis.mjs';
import { apiUrl, workerUrl, database, redis, question, jar, repo, timestamp, sha, harnessSha256, openRun, sql,
  docker, jobRowsQuery, pending, redisCommand, redisSnapshot as redisSnapshotOf, startSpring, ready, metrics,
  killRemaining, healthLoop as watchHealth, assertPortsFree, modelList, loginMembers,
  submitQuestions } from '../lib/harness.mjs';

// 실제 로컬 모델과 기존 전용 테스트 DB만 사용함. DB 상태나 복구 시계를 수정하지 않음
const { config, directory, write, event } = await openRun();
const owned = [];
let jobIds = [];
let monitor = true;
const probes = [];
const snapshots = [];
let healthTask;
let workerHealthTask;
let outageTask;
let outageAccessTask;
const outageAccessChecks = [];
let redisReadyAt;
let killedRedis = false;
const workerProbes = [];
const outageReads = [];
const DOWN_MILLISECONDS = 15000;

const jobQuery = () => jobRowsQuery(jobIds);
function snapshot() {
  const value = { at: timestamp(), rows: sql(jobQuery()) };
  assert.equal(value.rows.length, 100, '접수된 작업이 DB에서 사라졌습니다.');
  snapshots.push(value);
  return value;
}
const redisSnapshot = () => redisSnapshotOf(jobIds);
async function waitRedis() {
  for (let i=0;i<100;i++) {
    try { if (redisCommand(['PING']) === 'PONG') return; } catch {
      // 재기동 대기
    }
    await wait(100);
  }
  throw Error('Redis 재기동 제한을 초과했습니다.');
}
const start = (role, name) => startSpring({ directory, owned, role, name });
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
  const persistence = JSON.parse(redisCommand(['--json','CONFIG','GET','save','appendonly']));
  await write('environment.json', { scenario:'redis-process-crash', commit, jarSha256: hash, harnessSha256: harnessHash, apiUrl, workerUrl, models, fixture,
    concurrency: 4, heartbeatTimeoutMs: 60000, recoveryIntervalMs: 15000, reclaimIdleMs: 300000,
    queueTimeoutMs: 600000, executionTimeoutMs: 180000, maxDeliveries: 3, syntheticMembers: 100,
    question, llmMocked: false, database, redis, persistence, downMilliseconds:DOWN_MILLISECONDS });
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
  const worker = start('worker', 'worker');
  await event('worker-start-requested', { pid: worker.pid });
  await ready(worker, workerUrl);
  const workerBeforeMetrics = await metrics(workerUrl);
  await writeFile(join(directory, 'worker-before.prom'), workerBeforeMetrics);
  workerHealthTask = healthLoop(workerUrl, workerProbes);
  // DB 처리 단계와 모델 서버 실행 중 요청을 함께 관찰함
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
  const redisBefore = redisSnapshot();
  await write('redis-before-kill.json', redisBefore);
  const killRequestedAt = timestamp();
  assert.equal(redis, 'ubot-chat-burst-live-redis-1');
  docker(['kill','--signal','KILL',redis]);
  killedRedis = true;
  const killed = JSON.parse(docker(['inspect','--format','{{json .State}}',redis]));
  assert.equal(killed.Running, false);
  assert.equal(killed.ExitCode, 137);
  const afterKill = snapshot();
  const faultState = stateAtFault(afterKill, Date.parse(killRequestedAt));
  const runningAtFault = afterKill.rows.filter(r => faultState.runningIds.includes(r.jobId));
  await event('redis-force-killed', { container: redis, killRequestedAt, exited: killed,
    running: runningAtFault.length, inflightModelRequests, inflightObservedAt,
    queued: faultState.statuses.QUEUED ?? 0,
    succeeded: faultState.statuses.SUCCEEDED ?? 0 });
  await write('immediately-after-kill.json', afterKill);
  const watched = config.watchQueuedJob
    ? submissions.find(s => faultState.queuedIds.includes(s.jobId))
    : submissions.find(s => s.jobId === (runningAtFault[0]?.jobId ?? submissions[0].jobId));
  outageTask = (async () => {
    while (!redisReadyAt && monitor) {
      const started = Date.now(); const observation = {at:timestamp(),jobId:watched.jobId};
      try {
        const r=await request(apiUrl,'GET',`/chat/jobs/${watched.jobId}`,undefined,
          accounts[submissions.indexOf(watched)].token,2000);
        observation.httpStatus=r.status; observation.status=r.body?.data?.status;
        if (r.status!==200) observation.errorCode=r.body?.code;
        observation.answerPresent=Boolean(r.body?.data?.answer?.trim());
      } catch { observation.httpStatus=0; observation.status='CLIENT_REQUEST_FAILED'; }
      observation.completedAt=timestamp(); observation.elapsedMs=Date.now()-started;
      outageReads.push(observation);
      await wait(500);
    }
  })();
  if (config.requireOutageReadSuccess) {
    outageAccessTask = (async () => {
      const owner=accounts[submissions.indexOf(watched)];
      const other=accounts.find(a=>a.userId!==owner.userId);
      const parts=owner.token.split('.');
      parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
      for (const c of [{name:'owner',token:owner.token,expected:200},
        {name:'other-member',token:other.token,expected:404},
        {name:'invalid-signature',token:parts.join('.'),expected:401}]) {
        const began=Date.now();
        const result={name:c.name,at:timestamp(),expectedStatus:c.expected};
        try {
          const r=await request(apiUrl,'GET',`/chat/jobs/${watched.jobId}`,undefined,c.token,2000);
          result.httpStatus=r.status; if (r.status!==200) result.errorCode=r.body?.code;
        } catch { result.httpStatus=0; }
        result.completedAt=timestamp();result.elapsedMs=Date.now()-began;
        outageAccessChecks.push(result);
      }
    })();
  }
  while (Date.now() - Date.parse(killed.FinishedAt) < DOWN_MILLISECONDS) {
    snapshot();
    assert.equal(worker.exitCode,null); assert.equal(api.exitCode,null);
    await wait(1000);
  }
  await write('before-redis-restart.json',snapshot());
  const restartRequestedAt = timestamp();
  docker(['start',redis]);
  await waitRedis();
  redisReadyAt = timestamp();
  killedRedis=false;
  const redisAfterRestart = redisSnapshot();
  await write('redis-immediately-after-restart.json',redisAfterRestart);
  await event('redis-restarted',{restartRequestedAt,redisReadyAt,missingMessages:100-redisAfterRestart.messagesMatched});
  await outageTask;
  if (outageAccessTask) await outageAccessTask;
  let final;
  let lastProgress = 0;
  while (Date.now() - Date.parse(restartRequestedAt) < 12 * 60 * 1000) {
    final = snapshot();
    if (final.rows.every(r => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(r.status))) break;
    if (Date.now() - lastProgress > 15000) {
      await event('recovery-progress', { statuses: final.rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}) });
      lastProgress = Date.now();
    }
    assert.equal(worker.exitCode, null);
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
  await workerHealthTask;
  await write('api-health.json', probes);
  await write('worker-health.json',workerProbes);
  await write('outage-job-reads.json',outageReads);
  await write('outage-access-checks.json',outageAccessChecks);
  const inFlightOutcomes = runningAtFault.map(old => {
    const current = final.rows.find(r => r.jobId === old.jobId);
    return { jobId: old.jobId, beforeStartedAtMs: old.startedAtMs, beforeHeartbeatAtMs: old.heartbeatAtMs,
      finalStartedAtMs: current.startedAtMs, finishedAtMs: current.finishedAtMs, status: current.status,
      leaseChanged: current.startedAtMs > old.startedAtMs };
  });
  const allFinishedAtMs = Math.max(...final.rows.map(r => r.finishedAtMs ?? 0));
  const failed = final.rows.filter(r => r.status !== 'SUCCEEDED');
  const duplicateTurns = final.rows.filter(r => r.turnRows > 1 || r.duplicateSubQuestions > 0);
  const workerLog = await readFile(join(directory, 'worker.log'), 'utf8');
  const startedCounts = {};
  // 커밋 뒤에 찍히는 저장 완료 로그만 셈. 트랜잭션 안의 완료 로그는 커밋 실패 후 재실행 때 두 번 남을 수 있음
  // 참고용이며 중복 판정은 DB 저장본(duplicateTurns·savedTurns)으로 함
  const completedCounts = {};
  const allLlmRoutes = new Set();
  for (const name of ['worker']) {
    const log = await readFile(join(directory, `${name}.log`), 'utf8');
    for (const match of log.matchAll(/답변 작업을 시작합니다: 작업ID=(\d+)/g)) {
      if (jobIds.includes(Number(match[1]))) startedCounts[match[1]] = (startedCounts[match[1]] ?? 0) + 1;
    }
    for (const match of log.matchAll(/답변 작업의 결과 저장을 마쳤습니다: 작업ID=(\d+)/g)) {
      if (jobIds.includes(Number(match[1]))) completedCounts[match[1]] = (completedCounts[match[1]] ?? 0) + 1;
    }
    for (const match of log.matchAll(/CHAT route: attemptId=(\d+), source=LLM/g)) allLlmRoutes.add(Number(match[1]));
  }
  const queuedAtKill = faultState.queuedIds;
  const resumed = final.rows.filter(r=>queuedAtKill.includes(r.jobId) && r.startedAtMs);
  const firstApiHealthy=probes.find(p=>Date.parse(p.at)>=Date.parse(redisReadyAt)&&p.httpStatus===200&&p.status==='UP');
  const firstWorkerHealthy=workerProbes.find(p=>Date.parse(p.at)>=Date.parse(redisReadyAt)&&p.httpStatus===200&&p.status==='UP');
  const processStart = text=>text.match(/^process_start_time_seconds.*$/m)?.[0];
  const report = { verifiedAt: timestamp(), accepted: 100, uniqueJobIds: new Set(jobIds).size,
    killRequestedAt, redisExitedAt: killed.FinishedAt, restartRequestedAt, redisReadyAt,
    inflightModelRequests, inflightObservedAt,
    runningAtKill: runningAtFault.length, queuedAtKill: queuedAtKill.length,
    succeededAtKill: faultState.statuses.SUCCEEDED ?? 0, faultState,
    succeeded: final.rows.filter(r => r.status === 'SUCCEEDED').length, failed, inFlightOutcomes,
    missingJobs: 100 - final.rows.length, unfinished: final.rows.filter(r => !r.finishedAtMs).length,
    duplicateTurns: duplicateTurns.length, savedTurns: final.rows.reduce((n, r) => n + r.turnRows, 0),
    emptyAnswers: final.rows.reduce((n, r) => n + r.emptyAnswers, 0),
    apiAnswers: answers.filter(a => a.httpStatus === 200 && a.status === 'SUCCEEDED' && a.answer?.trim()).length,
    repeatedExecutions: Object.entries(startedCounts).filter(([, count]) => count > 1),
    executionStarts: Object.values(startedCounts).reduce((a, n) => a + n, 0),
    llmRouteJobs: final.rows.filter(r => allLlmRoutes.has(r.attemptId)).length,
    duplicateCommittedLogs: Object.values(completedCounts).filter(count => count > 1).length,
    uniqueCommittedLogs: Object.keys(completedCounts).length,
    apiProcessStartUnchanged: Boolean(processStart(apiMetrics)) && processStart(apiMetrics)===processStart(apiAfter),
    workerProcessStartUnchanged: Boolean(processStart(workerBeforeMetrics)) && processStart(workerBeforeMetrics)===processStart(workerAfter),
    apiProbeCount: probes.length, apiProbeFailures: probes.filter(p => p.httpStatus !== 200 || p.status !== 'UP').length,
    workerProbeCount:workerProbes.length, workerProbeFailures:workerProbes.filter(p=>p.httpStatus!==200||p.status!=='UP').length,
    outageJobReads:outageReads,
    outageAccessChecks,
    apiPid: api.pid, workerPid: worker.pid,
    redisBefore,redisAfterRestart,redisExitCode:killed.ExitCode,
    redisRunIdChanged:redisBefore.runId!==redisAfterRestart.runId,
    queuedAtKillIds:queuedAtKill,
    completedWhileRedisUnavailable:final.rows.filter(r=>r.finishedAtMs>=Date.parse(killRequestedAt)&&r.finishedAtMs<Date.parse(redisReadyAt)).length,
    republishedBatchCounts:[...workerLog.matchAll(/발행되지 않은 답변 작업을 다시 발행했습니다: 작업수=(\d+)/g)].map(m=>Number(m[1])),
    redisPending: finalPending[0],
    timingsMs: { forcedExit: Date.parse(killed.FinishedAt) - Date.parse(killRequestedAt),
      redisUnavailable:Date.parse(redisReadyAt)-Date.parse(killed.FinishedAt),
      restartStartup: Date.parse(redisReadyAt) - Date.parse(restartRequestedAt),
      redisReadyToQueueResume:Math.min(...resumed.map(r=>r.startedAtMs))-Date.parse(redisReadyAt),
      killToQueueResume:Math.min(...resumed.map(r=>r.startedAtMs))-Date.parse(killRequestedAt),
      redisReadyToApiHealthy:firstApiHealthy?Date.parse(firstApiHealthy.completedAt)-Date.parse(redisReadyAt):null,
      redisReadyToWorkerHealthy:firstWorkerHealthy?Date.parse(firstWorkerHealthy.completedAt)-Date.parse(redisReadyAt):null,
      redisReadyToAllAnswers:allFinishedAtMs-Date.parse(redisReadyAt),
      killToAllAnswers: allFinishedAtMs - Date.parse(killRequestedAt),
      restartToAllAnswers: allFinishedAtMs - Date.parse(restartRequestedAt),
      firstSubmissionToAllAnswers: allFinishedAtMs - Math.min(...submissions.map(s => Date.parse(s.startedAt))) },
    answerSamples: answers.filter(a => runningAtFault.some(r => r.jobId === a.jobId)).slice(0, 3)
      .map(({ jobId, answer, status }) => ({ jobId, answer, status })) };
  report.passed = report.succeeded === 100 && report.missingJobs === 0 && report.unfinished === 0 &&
    report.duplicateTurns === 0 && report.savedTurns === 100 && report.emptyAnswers === 0 && report.apiAnswers === 100 &&
    Boolean(firstApiHealthy && firstWorkerHealthy) && report.redisPending === 0 && report.llmRouteJobs === 100 &&
    report.apiProcessStartUnchanged &&
    report.workerProcessStartUnchanged && report.redisRunIdChanged && inFlightOutcomes.every(r => r.status === 'SUCCEEDED');
  if (config.requireOutageReadSuccess) {
    const duringOutage=outageReads.filter(r=>Date.parse(r.at)>=Date.parse(killed.FinishedAt)
      && Date.parse(r.completedAt)<=Date.parse(redisReadyAt));
    report.outageReadsWithinLimit=duringOutage.length>0 && duringOutage.every(r=>r.httpStatus===200&&r.elapsedMs<2000);
    report.outageAuthorizationPreserved=outageAccessChecks.length===3 && outageAccessChecks.every(r=>r.httpStatus===r.expectedStatus);
    report.passed=report.passed&&report.outageReadsWithinLimit&&report.outageAuthorizationPreserved;
  }
  await write('report.json', report);
  await event('verification-completed', { passed: report.passed, succeeded: report.succeeded,
    runningAtKill: report.runningAtKill, duplicateTurns: report.duplicateTurns, timingsMs: report.timingsMs });
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
  if(killedRedis) { docker(['start',redis]); await waitRedis(); redisReadyAt=timestamp(); }
  monitor = false;
  if (healthTask) await healthTask;
  if (workerHealthTask) await workerHealthTask;
  if (outageTask) await outageTask;
  if (outageAccessTask) await outageAccessTask;
  await write('api-health.json', probes);
  await write('db-snapshots.json', snapshots);
  await write('worker-health.json',workerProbes);
  await write('outage-job-reads.json',outageReads);
  await write('outage-access-checks.json',outageAccessChecks);
  await killRemaining(owned);
  await write('cleanup.json', { at: timestamp(), processes: owned.map(p => ({ pid: p.pid, exitCode: p.exitCode, signal: p.signalCode })),
    testDataRetained: true });
}
