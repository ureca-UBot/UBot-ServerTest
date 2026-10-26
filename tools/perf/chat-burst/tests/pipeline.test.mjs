import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepare, issueTokens, runBurst, collect, report } from '../cli.mjs';

// 외부 서비스·개발 DB·실제 모델은 사용하지 않음. 실제 k6 실행과 도구의 API 계약을 검증함
const questions = { forbidden: ['금지어 테스트'], threshold: ['기준 미달 테스트'], cache: ['캐시 테스트'], llm: ['LLM 테스트'] };
const groupFor = question => Object.keys(questions).find(group => questions[group].includes(question));

async function fixture(t) {
  await mkdir(resolve('build/chat-burst-tests'), { recursive: true });
  const directory = await mkdtemp(resolve('build/chat-burst-tests/run-'));
  const users = new Map(), tokens = new Map(), refreshes = new Map(), jobs = new Map();
  const logs = [], requests = [], pollTimes = [];
  let userId = 0, jobId = 0, tokenSequence = 0;
  let failSignup = false, rateLimitOnce = false, unauthorizedOnce = false;
  function login(user) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `test.${Buffer.from(JSON.stringify({ sub: String(user.id), role: 'USER', exp,
      nonce: ++tokenSequence })).toString('base64url')}.test`;
    const refresh = `refresh-${tokenSequence}`;
    tokens.set(token, user);
    refreshes.set(refresh, user);
    return { accessToken: token, refreshToken: refresh };
  }
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const send = (status, data, code = 'SUCCESS') => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: status < 400, code, data }));
    };
    if (req.url === '/api/actuator/health') return send(200, { status: 'UP' });
    if (req.url === '/api/auth/signup') {
      if (failSignup) { failSignup = false; return send(503, null, 'TEST-UNAVAILABLE'); }
      if (users.has(body.email)) return send(409, null, 'USER-003');
      assert.ok(body.password.length >= 8 && body.password === body.passwordConfirm);
      assert.equal(body.gender, 'MALE');
      users.set(body.email, { id: ++userId, email: body.email, password: body.password });
      return send(200, null);
    }
    if (req.url === '/api/auth/login') {
      const user = users.get(body.email);
      if (!user || user.password !== body.password) return send(401, null, 'USER-002');
      return send(200, login(user));
    }
    if (req.url === '/api/auth/refresh') {
      const user = refreshes.get(body.refreshToken);
      if (!user) return send(401, null, 'JWT-INVALID');
      refreshes.delete(body.refreshToken);
      return send(200, login(user));
    }
    const user = tokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!user) return send(401, null, 'JWT-INVALID');
    if (req.url === '/api/chat/questions' && req.method === 'POST') {
      const group = groupFor(body.question);
      requests.push({ userId: user.id, group, at: Date.now() });
      if (group === 'forbidden') return send(400, null, 'FW-003');
      const id = ++jobId, attempt = id + 10000;
      logs.push(`답변 작업을 접수했습니다: 작업ID=${id}, 시도ID=${attempt}, 재시도횟수=1`);
      if (group === 'threshold') {
        logs.push(`FAQ 유사도 검색을 완료했습니다: 시도ID=${attempt}, 하위질문순번=1, 최고유사도=0.3`);
        logs.push(`FAQ 유사도가 기준값 미만입니다: 시도ID=${attempt}, 하위질문순번=1, 최고유사도=0.3, 기준값=0.75`);
      } else logs.push(`CHAT route: attemptId=${attempt}, source=${group === 'cache' ? 'OFFICIAL_FAQ' : 'LLM'}, faqIds=[1]`);
      jobs.set(id, { userId: user.id, jobId: id, status: group === 'threshold' ? 'FAILED' : 'SUCCEEDED',
        errorCode: group === 'threshold' ? 'CHAT-013' : null, answer: '보고서에 남기면 안 되는 답변' });
      return send(202, { jobId: id, status: 'QUEUED' });
    }
    const match = req.url.match(/^\/api\/chat\/jobs\/(\d+)$/);
    if (match) {
      pollTimes.push(Date.now());
      if (rateLimitOnce) { rateLimitOnce = false; return send(429, null, 'RATE-001'); }
      if (unauthorizedOnce) { unauthorizedOnce = false; return send(401, null, 'JWT-EXPIRED'); }
      const job = jobs.get(Number(match[1]));
      return job?.userId === user.id ? send(200, job) : send(404, null, 'CHAT-020');
    }
    return send(404, null, 'NOT-FOUND');
  });
  server.keepAliveTimeout = 150000;
  await new Promise(resolveListen => server.listen({ port: 0, host: '127.0.0.1', backlog: 4096 }, resolveListen));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { directory, baseUrl: `http://127.0.0.1:${server.address().port}/api`, users, jobs, requests, pollTimes,
    logs, setFailSignup: () => { failSignup = true; }, setRateLimit: () => { rateLimitOnce = true; },
    setUnauthorized: () => { unauthorizedOnce = true; } };
}

test('실제 k6로 회원 1500명의 질문을 한 번씩 보내고 네 그룹을 집계한다', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  await prepare({ ...f, runId: 'local-1500', questions, concurrency: 8 });
  assert.equal(f.users.size, 1500);
  const code = await runBurst({ ...f, quiet: true, startDelaySeconds: 15 });
  assert.equal(code, 0, `k6 실행 실패. ${f.directory}의 로그를 확인하세요.`);
  assert.equal(f.requests.length, 1500);
  assert.equal(new Set(f.requests.map(r => r.userId)).size, 1500);
  assert.equal(f.pollTimes.length, 0, '접수 부하에 폴링을 섞지 않는다.');
  const result = await collect({ ...f, rps: 18, maxWaitSeconds: 100 });
  assert.equal(result.pending, 0);
  assert.equal(Object.keys(result.jobs).length, 1200);
  for (let i = 1; i < f.pollTimes.length; i++) assert.ok(f.pollTimes[i] - f.pollTimes[i - 1] >= 40);
  const logFile = join(f.directory, 'server.log');
  await writeFile(logFile, f.logs.join('\n'));
  const counted = await report({ ...f, logs: [logFile] });
  assert.equal(counted.passed, true);
  assert.deepEqual(counted.actual, { forbidden: 300, threshold: 300, cache: 450, llm: 450 });
  const contents = await readFile(join(f.directory, 'report.json'), 'utf8');
  assert.ok(!contents.includes('accessToken') && !contents.includes('refreshToken') && !contents.includes('보고서에 남기면'));
  await assert.rejects(runBurst({ ...f, quiet: true }), /이미 시작한 실행/);
  const missingEvidence = await report({ directory: f.directory });
  assert.equal(missingEvidence.passed, false);
  assert.equal(missingEvidence.actual.unverified_success, 900);
  // 검증 완료 보고서를 다시 남김
  await report({ ...f, logs: [logFile] });
  console.log(`1500건 로컬 k6 검증 결과: ${join(f.directory, 'report.json')}`);
});

test('회원 생성 실패 후 재개·토큰 갱신·429 백오프·조회 재개를 검증한다', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.setFailSignup();
  await assert.rejects(prepare({ ...f, runId: 'resume-test', questions, total: 10 }), /signup/);
  await prepare({ ...f, runId: 'resume-test', questions, total: 10 });
  assert.equal(f.users.size, 10);
  await issueTokens(f.directory);
  // k6를 다시 띄우지 않고, 이 테스트에서는 소량의 접수 결과를 직접 준비함
  const credentials = JSON.parse(await readFile(join(f.directory, 'credentials.private.json')));
  const events = [];
  for (const account of credentials.accounts.slice(0, 2)) {
    const response = await fetch(`${f.baseUrl}/chat/questions`, { method: 'POST',
      headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: questions.cache[0] }) });
    const payload = await response.json();
    events.push({ type: 'chat-burst-submission', runId: 'resume-test', caseId: account.caseId,
      jobId: payload.data.jobId, httpStatus: 202, startedAt: Date.now(), elapsedMs: 1 });
  }
  await writeFile(join(f.directory, 'submissions.ndjson'), events.map(e => JSON.stringify(e)).join('\n'));
  f.setRateLimit();
  f.setUnauthorized();
  const result = await collect({ ...f, rps: 18, maxWaitSeconds: 15, pollIntervalMs: 10 });
  assert.equal(result.pending, 0);
  assert.equal(result.errors['429:RATE-001'], 1);
  assert.equal(result.errors['401:JWT-EXPIRED'], 1);
  assert.equal(result.refreshes, 1);
  const polls = f.pollTimes.length;
  await collect({ ...f, maxWaitSeconds: 1 });
  assert.equal(f.pollTimes.length, polls, '이미 완료한 작업은 재조회하지 않는다.');
  await assert.rejects(collect({ ...f, rps: 21 }), /18회 이하/);
});

test('기존 파일이 있는 출력 폴더는 네트워크 요청 전에 거절한다', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, '.gitignore'), 'existing-file\n');
  await assert.rejects(prepare({ ...f, runId: 'protect-output', questions, total: 10 }), /비어 있는 전용 출력 폴더/);
  assert.equal(await readFile(join(f.directory, '.gitignore'), 'utf8'), 'existing-file\n');
  assert.equal(f.users.size, 0);
});

test('동시 실행 명령 중 하나만 전송권을 얻는다', async t => {
  const f = await fixture(t);
  await prepare({ ...f, runId: 'exclusive-run', questions, total: 10 });
  // 실행 파일을 일부러 없애 외부 전송 없이 동시 시작 경쟁만 검증함
  const options = { ...f, quiet: true, k6: join(f.directory, 'not-an-executable') };
  const results = await Promise.allSettled([runBurst(options), runBurst(options)]);
  assert.equal(results.filter(r => r.status === 'rejected' && /k6를 실행할 수 없습니다/.test(r.reason.message)).length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && /EEXIST|이미 시작한 실행/.test(r.reason.message)).length, 1);
  assert.equal(f.requests.length, 0);
});
