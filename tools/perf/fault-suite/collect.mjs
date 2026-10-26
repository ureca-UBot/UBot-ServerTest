import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { latency, summarize } from '../vllm-crash/model.mjs';

// 개별 장애 도구의 원본과 독립 SQL 검증을 대조해 같은 JAR의 통합 결과를 만듦
const root = resolve(process.argv[2]);
assert.ok(root.startsWith(resolve('build') + '\\'));
const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const sha = value => createHash('sha256').update(value).digest('hex');
const before = await read(join(root, 'metadata-before.json'));
const after = await read(join(root, 'metadata-after.json'));
const aggregationTests = await read(join(root, 'aggregation-tests.json'));
assert.equal(aggregationTests.failures, 0);
assert.equal(before.jarSha256, after.jarSha256, '검증 중 JAR 변경');
assert.equal(before.runtimeSourceManifestSha256, after.runtimeSourceManifestSha256, '검증 중 운영 소스 변경');
const scenarios = [];
for (const name of ['worker', 'redis', 'postgres', 'vllm']) {
  const directory = join(root, name);
  const report = await read(join(directory, 'report.json'));
  const environment = await read(join(directory, 'environment.json'));
  const submissions = await read(join(directory, 'submissions.json'));
  const responses = await read(join(directory, 'api-final.json'));
  const final = await read(join(directory, 'db-final.json'));
  const audit = await read(join(directory, 'independent-audit.json'));
  const events = await read(join(directory, 'events.json'));
  const cleanup = await read(join(directory, 'cleanup.json'));
  const counts = summarize(final.rows, submissions, responses);
  assert.equal(environment.jarSha256, before.jarSha256, `${name} JAR 불일치`);
  assert.equal(environment.concurrency, 4);
  assert.equal(environment.llmMocked, false);
  assert.equal(environment.executionTimeoutMs, 180000);
  assert.equal(report.passed ?? report.verificationPassed, true, `${name} 도구 검증 실패`);
  const atKill = await read(join(directory, 'immediately-before-kill.json'));
  assert.equal(atKill.rows.filter(r => r.status === 'RUNNING').length, 4);
  assert.equal(atKill.rows.filter(r => r.status === 'QUEUED').length, 96);
  assert.ok((report.inflightModelRequests ?? report.modelRunning) > 0);
  assert.equal(counts.succeeded, 100);
  assert.equal(audit.succeededJobs, 100);
  assert.equal(audit.answerMismatches + audit.ownershipMismatches + audit.duplicateTurns + audit.missingOrUnfinished, 0);
  assert.equal(cleanup.processes.every(p => p.exitCode !== null || p.signal), true);
  let apiDuringOutage;
  if (name === 'worker') {
    const samples = events.filter(e => e.type === 'api-job-read-while-worker-dead');
    apiDuringOutage = { count: samples.length, statuses: { 200: samples.filter(e => e.httpStatus === 200).length },
      p50Ms: null, p95Ms: null, maxMs: null, note: '워커 부재 중 5회 상태 응답 확인. 별도 지연 계측 없음.' };
  } else {
    const samples = await read(join(directory, name === 'vllm' ? 'api-job-reads.json' : 'outage-job-reads.json'));
    const exited = report.redisExitedAt ?? report.databaseExitedAt ?? report.modelExitedAt;
    const ready = report.redisReadyAt ?? report.databaseReadyAt ?? report.modelReadyAt;
    apiDuringOutage = latency(samples.filter(p => Date.parse(p.at) >= Date.parse(exited) && Date.parse(p.completedAt) <= Date.parse(ready)));
  }
  const health = await read(join(directory, 'api-health.json'));
  let modelRetryDeadlinesUnchanged = null;
  if (name === 'vllm') {
    const snapshots = await read(join(directory, 'db-snapshots.json'));
    for (const original of atKill.rows.filter(r => r.status === 'RUNNING')) {
      const observations = snapshots.flatMap(s => s.rows.filter(r => r.jobId === original.jobId && r.status === 'RUNNING'));
      assert.ok(observations.length > 1);
      assert.ok(observations.every(r => r.startedAtMs === original.startedAtMs && r.deadlineAtMs === original.deadlineAtMs));
      assert.ok(observations.some(r => r.heartbeatAtMs > original.heartbeatAtMs));
    }
    modelRetryDeadlinesUnchanged = true;
  }
  const evidence = [];
  for (const file of (await readdir(directory, { withFileTypes: true })).filter(f => f.isFile()).map(f => f.name).sort()) {
    evidence.push({ file, sha256: sha(await readFile(join(directory, file))) });
  }
  scenarios.push({ name, verifiedAt: report.verifiedAt, jarSha256: environment.jarSha256,
    counts, apiDuringOutage, apiFinal: { responses: responses.length, http200: responses.filter(r => r.httpStatus === 200).length },
    health: { count: health.length, statuses: health.reduce((a, p) => ({ ...a, [p.httpStatus]: (a[p.httpStatus] ?? 0) + 1 }), {}) },
    inflightModelRequests: report.inflightModelRequests ?? report.modelRunning,
    executionStarts: report.executionStarts ?? report.originalExecutionStarts,
    repeatedExecutions: report.repeatedExecutions ?? report.repeatedOriginalExecutions,
    manualRetryRequests: report.manualRetryRequests ?? 0,
    modelRetryWaits: report.retryWaits ?? null, modelRetryDeadlinesUnchanged,
    redisPending: report.redisPending, timingsMs: report.timingsMs,
    recoveryDetails: { redisRepublishedBatches: report.republishedBatchCounts ?? [],
      heartbeatTakeovers: report.heartbeatTakeovers ?? [], completionNotAcknowledged: report.completionNotAcknowledged ?? [],
      longDatabaseRead: report.longRead ?? null, securityChecks: report.securityChecks ?? report.outageAccessChecks ?? report.invalidTokenChecks ?? [],
      automaticReclaimedJobs: report.recovered ?? report.inFlightOutcomes ?? report.inFlight ?? [] },
    audit, evidence, cleanup, passed: true });
}
for (const name of ['ubot-feat-200-postgres-1', 'ubot-feat-200-redis-1', 'ubot-feat-200-vllm-embedding-1']) {
  const old = before.infrastructure.find(i => i.name === name);
  const current = after.infrastructure.find(i => i.name === name);
  assert.equal(current.running, true); assert.equal(old.startedAt, current.startedAt, `${name} 의도하지 않은 재시작`);
}
const modelBefore = before.infrastructure.find(i => i.name === 'ubot-feat-200-vllm-1');
const modelAfter = after.infrastructure.find(i => i.name === 'ubot-feat-200-vllm-1');
assert.equal(modelAfter.running, true); assert.equal(modelBefore.id, modelAfter.id);
assert.equal(modelBefore.image, modelAfter.image); assert.deepEqual(modelBefore.restartPolicy, modelAfter.restartPolicy);
const output = resolve('tools/perf/fault-suite/results');
await mkdir(output, { recursive: true });
const result = { verifiedAt: new Date().toISOString(), commit: before.commit,
  jarSha256: before.jarSha256, runtimeSourceManifestSha256: before.runtimeSourceManifestSha256,
  runtimeCodeUnchangedDuringSuite: true, llmMocked: false, concurrency: 4,
  executionTimeoutMs: 180000, totalTimeoutMs: 600000, modelRetryBackoffMs: 5000,
  accepted: 400, succeeded: scenarios.reduce((n, s) => n + s.counts.succeeded, 0),
  passed: scenarios.every(s => s.passed), scenarios, infrastructureBefore: before.infrastructure,
  infrastructureAfter: after.infrastructure, rawEvidenceDirectory: root, aggregationTests,
  collectorSha256: sha(await readFile(new URL(import.meta.url))),
  suiteMetadataEvidence: await Promise.all(['metadata-before.json', 'metadata-after.json', 'infrastructure-cleanup.json', 'audit.mjs', 'capture.mjs', 'finalize.mjs', 'aggregation-tests.json', 'aggregation-tests.tap']
    .map(async file => ({ file, sha256: sha(await readFile(join(root, file))) }))) };
const seconds = ms => ms == null ? '—' : `${(ms / 1000).toFixed(2)}초`;
const labels = { worker: '워커 강제 종료', redis: 'Redis 강제 종료', postgres: 'PostgreSQL 강제 종료', vllm: 'vLLM 강제 종료' };
const table = scenarios.map(s => `| ${labels[s.name]} | ${s.counts.succeeded}/100 | ${s.counts.missingJobs}/${s.counts.duplicateAnswers}/${s.counts.failed}/${s.counts.timeouts} | ${s.apiDuringOutage.count}회 ${Object.entries(s.apiDuringOutage.statuses).map(([code, n]) => `${code}: ${n}`).join(', ')} | ${s.apiDuringOutage.p95Ms ?? '미계측'} / ${s.apiDuringOutage.maxMs ?? '미계측'} | ${seconds(s.timingsMs.killToAllAnswers)} |`).join('\n');
const byName = Object.fromEntries(scenarios.map(s => [s.name, s]));
const md = `# 최신 코드 4종 장애 재검증 — 2026-10-23

**동일한 최신 JAR로 실제 LLM 100건씩, 총 400건을 모두 성공했다.** 각 시나리오에서 유실·중복 저장·최종 실패·작업 타임아웃·미완료는 0건이다. 사용자 재접수·재시도 API는 호출하지 않았다.

## 실행 기준

- 기준 커밋: ${before.commit}. 미커밋 운영 소스를 포함한 JAR SHA-256: \`${before.jarSha256}\`.
- 운영 소스 ${before.runtimeSources.length}개 manifest SHA-256: \`${before.runtimeSourceManifestSha256}\`. 검증 전후 소스·JAR 해시가 동일하다.
- 합성 USER 회원 100명으로 매번 실제 로그인, 별도 API/Worker JVM, 비캐시 FAQ 질문, 실제 Qwen3-4B vLLM·BGE-M3, RTX 3060 12 GiB. 워커와 LLM 동시 실행은 4.
- 매번 새 작업 100건을 모두 202/DB QUEUED로 접수한 뒤 워커를 시작했다. DB 실행 4건·대기 96건과 실제 vLLM 처리 요청을 확인한 후 종료했다.
- 개발 PostgreSQL(15432)·Redis(16379)를 유지하고 전용 PostgreSQL(25432)·Redis(26379)로 수행했다. vLLM 시나리오는 로컬 chat 모델만 종료·재기동했다.
- 완료 시간은 장애 종료 요청부터 DB의 마지막 finished_at까지다. HTTP 폴링 지연과 UI 렌더링은 포함하지 않는다. 실패에 타임아웃이 포함되므로 두 수치는 합산하지 않는다.

## 전체 결과

| 장애 | 성공 | 유실/중복/실패/타임아웃 | 장애 중 작업 GET | GET p95 / 최대(ms) | 장애 주입 → 전체 답변 저장 |
|---|---:|---:|---|---:|---:|
${table}

모든 시나리오의 최종 답변 재조회는 각각 100/100 HTTP 200이다. API 200은 상태 조회 성공을 뜻하며 답변 성공은 별도 DB 상태와 저장 답변으로 확인했다. DB 장애 중 503은 의도한 빠른 실패 응답이며 답변 작업 실패로 세지 않았다.

## 복구 동작

- **워커:** 새 워커 준비 ${seconds(byName.worker.timingsMs.killToReplacementReady)}, 중단 작업 첫 회수 ${seconds(byName.worker.timingsMs.killToFirstInterruptedRestart)}, 첫 중단 답변 저장 ${seconds(byName.worker.timingsMs.killToFirstInterruptedAnswer)}. 실행 시작 ${byName.worker.executionStarts}회로 중단된 작업을 재실행했지만 저장 답변은 100개뿐이다. heartbeat 60초·복구 확인 15초의 기존 정책을 유지했다.
- **Redis:** 실제 중단 ${seconds(byName.redis.timingsMs.redisUnavailable)}, PONG 이후 대기 작업 소비 재개 ${seconds(byName.redis.timingsMs.redisReadyToQueueResume)}. DB 기반 자동 재발행 배치 ${JSON.stringify(byName.redis.recoveryDetails.redisRepublishedBatches)}. 장애 중 인증·소유권 검사를 유지했고 토큰 폐기 조회에만 200ms 제한을 사용했다.
- **PostgreSQL:** 실제 중단 ${seconds(byName.postgres.timingsMs.databaseUnavailable)}, SQL 준비 후 작업 GET 첫 200 ${seconds(byName.postgres.timingsMs.databaseReadyToJobHealthy)}, 소비 재개 ${seconds(byName.postgres.timingsMs.databaseReadyToQueueResume)}. 45초 제한 클라이언트의 별도 GET도 ${byName.postgres.recoveryDetails.longDatabaseRead?.elapsedMs}ms에 503/CHAT-025로 응답했다. 같은 볼륨으로 WAL 복구했으며 전역 JDBC/Hikari 제한은 바꾸지 않았다.
- 이번 DB 실행은 결과 저장에 실패해 ACK를 보류한 작업 ${byName.postgres.recoveryDetails.completionNotAcknowledged.length}건을 heartbeat 회수로 자동 재실행했다. 실행 시작은 ${byName.postgres.executionStarts}회였고 최종 저장 답변은 100개다. 이번 DB 완료 시간에는 이 회수 대기 구간이 포함된다.
- **vLLM:** 실제 중단 ${seconds(byName.vllm.timingsMs.modelUnavailable)}, 재기동 요청부터 모델 준비 ${seconds(byName.vllm.timingsMs.restartToReady)}. 준비 후 첫 자동 답변 ${seconds(byName.vllm.timingsMs.readyToFirstAnswer)}, 원래 100건 완료 ${seconds(byName.vllm.timingsMs.readyToAllAnswers)}. 모델 복구 대기 ${byName.vllm.modelRetryWaits}회이며 작업·사용자 시도를 새로 만들지 않았다. 기본 5초 재시도, 실행 180초와 접수 후 10분 중 빠른 마감을 지켰다.

## 데이터·서비스 검증

- 각 실행 후 독립 읽기 전용 SQL로 회원·대화·작업·시도·저장 답변 100개, 사용자 시도 횟수 1, HTTP/DB 답변 해시 100/100 일치, 소유권·결과 참조를 확인했다. 누락·중복·불일치·전체 미완료 작업은 0이다.
- 결과 집계 단위 테스트 ${aggregationTests.passed}건을 다시 실행해 모두 통과했다. 애플리케이션은 bootJar 빌드 후 같은 JAR로 4종 실제 장애 검증을 수행했다.
- 최종 Redis PEL은 네 실행 모두 0이다. 워커 종료 외 시나리오에서 API·Worker를 재기동하지 않았다. 장애 대상 외 의존성을 유지했다.
- Redis·DB 장애 중 actuator health는 의존성 장애를 계속 반영한다. 작업 GET 결과와 전체 서비스 health는 구분한다.
- 검증이 만든 JVM은 모두 종료했다. 전용 DB·Redis는 정지하고 볼륨은 보존했다. 기존 개발 서비스 4개가 실행 중이며 chat vLLM의 원래 재시작 정책도 복원됐다.
- 각각 한 번의 로컬 실행이다. 운영 성능·장기 장애·동시 다중 장애·원격 모델 계산의 exactly-once를 보장하는 결과는 아니다. 중복 여부는 저장 답변 기준이다.

[집계 JSON·증거 SHA-256](20261023-latest-code.json). 원본은 Git 제외 경로 \`${root}\`에 보존한다. 비밀번호·JWT는 공개 결과에 포함하지 않는다. 애플리케이션 운영 코드는 이번 재검증에서 수정하지 않았다.
`;
await writeFile(join(output, '20261023-latest-code.json'), JSON.stringify(result, null, 2) + '\n');
await writeFile(join(output, '20261023-latest-code.md'), md);
console.log(JSON.stringify({ passed: result.passed, succeeded: result.succeeded, scenarios: scenarios.map(s => ({ name: s.name, timingsMs: s.timingsMs, apiDuringOutage: s.apiDuringOutage })) }));
