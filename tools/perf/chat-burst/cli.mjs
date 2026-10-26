import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { makePlan, validatePlan, validateCredentials, tokenClaims, requireValue, TERMINAL,
  newEvidence, addLogLine, addDatabaseEvidence, aggregate, percentile } from './model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'credentials.private.json';
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const exists = async path => access(path).then(() => true, () => false);

async function save(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function request(base, method, path, body, token, timeoutMs = 15000) {
  try {
    const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let payload = null;
    try { payload = await response.json(); } catch {
      // 프록시의 HTML 응답도 HTTP 상태로 기록함
    }
    return { status: response.status, body: payload, retryAfter: response.headers.get('retry-after') };
  } catch { throw new Error(`${method} ${path}: 연결 실패 또는 시간 초과`); }
}

function successful(response, operation) {
  requireValue(response.status >= 200 && response.status < 300 && response.body?.success === true,
    `${operation}: HTTP ${response.status}, code=${response.body?.code ?? 'NON_JSON'}`);
  return response.body.data;
}

async function batches(items, concurrency, action, checkpoint) {
  requireValue(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16, '준비 동시 실행 수는 1~16입니다.');
  for (let start = 0; start < items.length; start += concurrency) {
    const results = await Promise.allSettled(items.slice(start, start + concurrency).map(action));
    await checkpoint();
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

export async function issueTokens(directory, concurrency = 4) {
  const plan = validatePlan(await json(join(directory, 'plan.json')));
  const credentials = await json(join(directory, SECRET));
  requireValue(credentials.runId === plan.runId && credentials.baseUrl === plan.baseUrl
    && credentials.accounts.length === plan.total, '회원 정보와 plan이 다릅니다.');
  await batches(credentials.accounts, concurrency, async account => {
    const data = successful(await request(plan.baseUrl, 'POST', '/auth/login',
      { email: account.email, password: credentials.password }), `login case=${account.caseId}`);
    const claims = tokenClaims(data?.accessToken);
    requireValue(typeof data.refreshToken === 'string' && data.refreshToken.length > 0, 'refreshToken이 없습니다.');
    Object.assign(account, claims, { accessToken: data.accessToken, refreshToken: data.refreshToken });
  }, () => save(join(directory, SECRET), credentials));
  validateCredentials(plan, credentials, Date.now() + 120000);
  await save(join(directory, 'auth-summary.json'), { count: credentials.accounts.length, issuedAt: new Date().toISOString(),
    earliestExpiry: new Date(Math.min(...credentials.accounts.map(a => a.expiresAt))).toISOString() });
  return credentials;
}

export async function prepare({ directory, runId, baseUrl, questions, total = 1500, concurrency = 4, password }) {
  const plan = makePlan({ runId, baseUrl, questions, total });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await exists(join(directory, 'plan.json'))) {
    requireValue(JSON.stringify(await json(join(directory, 'plan.json'))) === JSON.stringify(plan),
      '기존 실행과 plan이 다릅니다. 새 디렉터리·run-id를 사용하세요.');
  } else requireValue((await readdir(directory)).length === 0, '새 실행은 비어 있는 전용 출력 폴더가 필요합니다.');
  // 기존 프로젝트의 .gitignore를 덮어쓰지 않고 전용 출력 폴더만 Git에서 제외함
  if (await exists(join(directory, '.gitignore'))) {
    requireValue((await readFile(join(directory, '.gitignore'), 'utf8')).trim() === '*', '출력 폴더의 비밀 정보 제외 설정이 변경되었습니다.');
  } else await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx' });
  await save(join(directory, 'plan.json'), plan);
  let credentials;
  if (await exists(join(directory, SECRET))) {
    credentials = await json(join(directory, SECRET));
    requireValue(credentials.runId === runId && credentials.baseUrl === plan.baseUrl
      && credentials.accounts.length === total, '기존 회원 정보가 plan과 다릅니다.');
    requireValue(!password || password === credentials.password, '기존 실행과 비밀번호가 다릅니다.');
  } else {
    const chosenPassword = password || randomBytes(12).toString('base64url');
    requireValue(Buffer.byteLength(chosenPassword) >= 8 && Buffer.byteLength(chosenPassword) <= 20,
      '비밀번호는 UTF-8 8~20바이트여야 합니다.');
    credentials = { version: 1, runId, baseUrl: plan.baseUrl, password: chosenPassword,
      accounts: plan.cases.map(item => ({ caseId: item.caseId,
        email: `load+${runId}.${String(item.caseId).padStart(4, '0')}@example.test`, registered: false })) };
  }
  requireValue(credentials.accounts.every((account, index) => account.caseId === index + 1
    && account.email === `load+${runId}.${String(index + 1).padStart(4, '0')}@example.test`),
  '기존 회원 파일의 이메일·case가 이 실행과 일치하지 않습니다.');
  await save(join(directory, SECRET), credentials);
  await batches(credentials.accounts.filter(a => !a.registered), concurrency, async account => {
    const response = await request(plan.baseUrl, 'POST', '/auth/signup', { email: account.email,
      password: credentials.password, passwordConfirm: credentials.password, name: `부하테스트${account.caseId}`,
      birthDate: '1995-01-01', gender: 'MALE', residenceArea: '서울' });
    // 응답을 잃은 회원가입은 다음 실행에서 로그인으로 소유권을 확인함
    if (!(response.status === 409 && response.body?.code === 'USER-003')) {
      successful(response, `signup case=${account.caseId}`);
    }
    account.registered = true;
  }, () => save(join(directory, SECRET), credentials));
  const authenticated = await issueTokens(directory, concurrency);
  await writeFile(join(directory, 'evidence.sql'), databaseQuery(plan, authenticated), { mode: 0o600 });
  return plan;
}

function databaseQuery(plan, credentials) {
  const ids = credentials.accounts.map(a => tokenClaims(a.accessToken).userId).join(',');
  return `-- 읽기 전용. psql -qAt -f evidence.sql > db-evidence.json\nBEGIN READ ONLY;\nSET LOCAL statement_timeout = '10s';
SELECT COALESCE(json_agg(selected_jobs), '[]'::json) FROM (
 SELECT j.job_id AS "jobId", j.attempt_id AS "attemptId", j.execution_status AS status,
        extract(epoch FROM j.created_at AT TIME ZONE 'Asia/Seoul') * 1000 AS "createdMs",
        extract(epoch FROM j.started_at AT TIME ZONE 'Asia/Seoul') * 1000 AS "startedMs",
        extract(epoch FROM j.finished_at AT TIME ZONE 'Asia/Seoul') * 1000 AS "finishedMs"
 FROM chat_jobs j JOIN answer_attempts_history a ON a.attempt_id = j.attempt_id
 JOIN users u ON u.user_id = a.user_id
 WHERE u.user_id IN (${ids}) AND u.email LIKE 'load+${plan.runId}.%@example.test'
 ORDER BY j.job_id
) selected_jobs;\nCOMMIT;\n`;
}

export async function runBurst({ directory, startDelaySeconds = 15, maxStartSpreadMs = 1000,
  warmConnections = true, k6 = 'k6', quiet = false }) {
  const plan = validatePlan(await json(join(directory, 'plan.json')));
  requireValue(Number.isFinite(startDelaySeconds) && startDelaySeconds >= 2 && startDelaySeconds <= 120,
    '시작 대기는 2~120초입니다.');
  requireValue(Number.isFinite(maxStartSpreadMs) && maxStartSpreadMs > 0 && maxStartSpreadMs <= 10000,
    '시작 허용 범위는 1~10000ms입니다.');
  validateCredentials(plan, await json(join(directory, SECRET)), Date.now() + startDelaySeconds * 1000 + 120000);
  requireValue(!await exists(join(directory, 'run.json')) && !await exists(join(directory, 'submissions.ndjson')),
    '이미 시작한 실행입니다. 같은 첫 질문을 재전송하지 않으므로 새 run-id를 사용하세요.');
  const plannedStartAt = Date.now() + startDelaySeconds * 1000;
  const state = { runId: plan.runId, plannedStartAt, maxStartSpreadMs, warmConnections, startedAt: new Date().toISOString(), exitCode: null };
  // 두 실행 명령이 동시에 와도 하나만 전송권을 얻음. 응답 유실 후 중복 POST를 막음
  await writeFile(join(directory, 'run.json'), JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await save(join(directory, 'k6-config.json'), {});
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(K6_|BURST_)/i.test(key)));
  const args = ['run', '--config', join(directory, 'k6-config.json'), '--no-usage-report', '--log-format', 'raw', '--console-output', join(directory, 'submissions.ndjson'),
    ...(quiet ? ['--quiet'] : []), join(HERE, 'burst.js')];
  const code = await new Promise((resolveCode, reject) => {
    const output = createWriteStream(join(directory, 'k6-runtime.log'), { mode: 0o600 });
    const child = spawn(k6, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanEnvironment,
      BURST_PLAN: join(directory, 'plan.json'), BURST_CREDENTIALS: join(directory, SECRET),
      BURST_TOTAL: String(plan.total), BURST_START_AT: String(plannedStartAt), BURST_BASE_URL: plan.baseUrl,
      BURST_RUN_ID: plan.runId, BURST_MAX_START_SPREAD_MS: String(maxStartSpreadMs),
      BURST_WARM_CONNECTIONS: String(warmConnections),
      BURST_K6_SUMMARY: join(directory, 'k6-summary.json') } });
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    if (!quiet) {
      child.stdout.pipe(process.stdout, { end: false });
      child.stderr.pipe(process.stderr, { end: false });
    }
    child.once('error', () => { output.end(); reject(new Error('k6를 실행할 수 없습니다. 설치 경로를 확인하세요.')); });
    child.once('close', value => { output.end(); resolveCode(value ?? 1); });
  }).catch(async error => {
    await save(join(directory, 'run.json'), { ...state, finishedAt: new Date().toISOString(), exitCode: 1 });
    throw error;
  });
  await save(join(directory, 'run.json'), { ...state, finishedAt: new Date().toISOString(), exitCode: code });
  return code;
}

export async function readSubmissions(path) {
  const events = [];
  let invalidLines = 0;
  if (!await exists(path)) return { events, invalidLines: 1 };
  const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      let event = JSON.parse(line.replace(/^\uFEFF/, ''));
      if (typeof event.msg === 'string') event = JSON.parse(event.msg);
      if (event.type !== 'chat-burst-submission') throw new Error('type');
      events.push(event);
    } catch { invalidLines++; }
  }
  return { events, invalidLines };
}

export async function collect({ directory, rps = 15, maxWaitSeconds = 1800, pollIntervalMs = 2000 }) {
  requireValue(Number.isFinite(rps) && rps > 0 && rps <= 18, '단일 수집기의 조회 속도는 초당 18회 이하입니다.');
  requireValue(Number.isFinite(maxWaitSeconds) && maxWaitSeconds > 0, '수집 제한 시간은 양수여야 합니다.');
  const plan = validatePlan(await json(join(directory, 'plan.json')));
  const credentials = await json(join(directory, SECRET));
  validateCredentials(plan, credentials);
  const { events } = await readSubmissions(join(directory, 'submissions.ndjson'));
  const statePath = join(directory, 'jobs.json');
  const state = await exists(statePath) ? await json(statePath) : { jobs: {}, errors: {}, polls: 0, refreshes: 0 };
  const pending = new Map();
  for (const event of events) {
    requireValue(event.runId === plan.runId && Number.isInteger(event.caseId)
      && event.caseId >= 1 && event.caseId <= plan.total, '다른 실행의 접수 결과입니다.');
    if (event.httpStatus !== 202 || !Number.isSafeInteger(event.jobId)) continue;
    requireValue(!pending.has(event.jobId), '중복 jobId가 있어 수집을 중단합니다.');
    if (!TERMINAL.has(state.jobs[event.jobId]?.status)) pending.set(event.jobId, { event, nextAt: 0 });
  }
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let nextRequest = 0, globalBackoffUntil = 0, checkpoints = 0;
  while (pending.size && Date.now() < deadline) {
    const [jobId, entry] = [...pending].sort((a, b) => a[1].nextAt - b[1].nextAt)[0];
    await wait(Math.max(0, Math.max(entry.nextAt, nextRequest, globalBackoffUntil) - Date.now()));
    if (Date.now() >= deadline) break;
    nextRequest = Date.now() + Math.ceil(1000 / rps);
    const account = credentials.accounts[entry.event.caseId - 1];
    try {
      if (tokenClaims(account.accessToken).expiresAt < Date.now() + 30000 || entry.refreshNeeded) {
        const data = successful(await request(plan.baseUrl, 'POST', '/auth/refresh',
          { refreshToken: account.refreshToken }), `refresh case=${account.caseId}`);
        requireValue(tokenClaims(data.accessToken).userId === account.userId && typeof data.refreshToken === 'string',
          '갱신한 JWT의 소유자가 일치하지 않습니다.');
        Object.assign(account, tokenClaims(data.accessToken), { accessToken: data.accessToken, refreshToken: data.refreshToken });
        await save(join(directory, SECRET), credentials);
        state.refreshes++;
        entry.refreshNeeded = false;
      }
      // 인증 갱신 시간과 무관하게 실제 조회 간격을 다시 보장함
      nextRequest = Date.now() + Math.ceil(1000 / rps);
      const response = await request(plan.baseUrl, 'GET', `/chat/jobs/${jobId}`, undefined, account.accessToken);
      state.polls++;
      if (response.status === 200 && response.body?.success === true
          && response.body.data?.jobId === jobId && ['QUEUED', 'RUNNING', ...TERMINAL].includes(response.body.data.status)
          && (response.body.data.status !== 'SUCCEEDED'
            || (typeof response.body.data.answer === 'string' && response.body.data.answer.trim().length > 0))) {
        const job = response.body.data;
        // 답변·가입 정보·토큰을 보고서에 복사하지 않음
        state.jobs[jobId] = { status: job.status, errorCode: job.errorCode ?? null, observedAt: Date.now() };
        if (TERMINAL.has(job.status)) pending.delete(jobId);
      } else {
        const key = `${response.status}:${response.status === 200 ? 'INVALID_JOB_RESPONSE' : response.body?.code ?? 'NON_JSON'}`;
        state.errors[key] = (state.errors[key] ?? 0) + 1;
        if (response.status === 401) entry.refreshNeeded = true;
        if (response.status === 429) {
          globalBackoffUntil = Date.now() + Math.max(2000, Math.min(30000, Number(response.retryAfter) * 1000 || 2000));
        }
      }
    } catch {
      state.errors.transportOrAuth = (state.errors.transportOrAuth ?? 0) + 1;
      globalBackoffUntil = Date.now() + 2000;
    }
    entry.nextAt = Date.now() + pollIntervalMs;
    if (++checkpoints % 20 === 0) await save(statePath, state);
  }
  state.pending = pending.size;
  state.completedAt = new Date().toISOString();
  await save(statePath, state);
  return state;
}

export async function report({ directory, logs = [], databaseEvidence }) {
  const plan = validatePlan(await json(join(directory, 'plan.json')));
  const { events, invalidLines } = await readSubmissions(join(directory, 'submissions.ndjson'));
  const jobs = await exists(join(directory, 'jobs.json')) ? await json(join(directory, 'jobs.json')) : { jobs: {} };
  const evidence = newEvidence();
  for (const path of logs) {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) addLogLine(evidence, line);
  }
  const database = databaseEvidence ? await json(databaseEvidence) : [];
  addDatabaseEvidence(evidence, database);
  const run = await exists(join(directory, 'run.json')) ? await json(join(directory, 'run.json')) : {};
  const result = aggregate(plan, events, jobs.jobs, evidence, run.maxStartSpreadMs ?? 1000);
  result.k6ExitCode = run.exitCode ?? null;
  result.warmConnections = run.warmConnections ?? null;
  result.invalidEventLines = invalidLines;
  result.polling = { polls: jobs.polls ?? 0, refreshes: jobs.refreshes ?? 0, errors: jobs.errors ?? {} };
  result.passed &&= run.exitCode === 0 && invalidLines === 0;
  const timings = database.filter(row => Number.isFinite(row.createdMs) && Number.isFinite(row.startedMs)
    && Number.isFinite(row.finishedMs) && row.finishedMs >= row.startedMs && row.startedMs >= row.createdMs
    && TERMINAL.has(jobs.jobs[row.jobId]?.status) && jobs.jobs[row.jobId].status === row.status);
  result.serverTimings = { samples: timings.length,
    queueP95Ms: percentile(timings.map(r => r.startedMs - r.createdMs), .95),
    executionP95Ms: percentile(timings.map(r => r.finishedMs - r.startedMs), .95),
    totalP95Ms: percentile(timings.map(r => r.finishedMs - r.createdMs), .95) };
  await save(join(directory, 'report.json'), result);
  const csvFields = ['caseId', 'expected', 'actual', 'matched', 'httpStatus', 'jobId', 'errorCode', 'submissionMs', 'observedCompletionMs'];
  await writeFile(join(directory, 'results.csv'), [csvFields.join(','), ...result.rows.map(row =>
    csvFields.map(field => JSON.stringify(row[field] ?? '')).join(','))].join('\n') + '\n');
  await writeFile(join(directory, 'report.md'), `# 채팅 동시 부하 결과: ${plan.runId}\n\n판정: ${result.passed ? 'PASS' : 'FAIL / 미확인 결과 포함'}
\n| 그룹 | 목표 | 실제 |\n|---|---:|---:|\n${Object.entries(plan.expected).map(([group, count]) => `| ${group} | ${count} | ${result.actual[group]} |`).join('\n')}
\n- 기록: ${result.recorded}/${result.total}, case 불일치: ${result.mismatches}
- 요청 시작 범위: ${result.startSpreadMs ?? '미확인'}ms (허용 ${result.maxStartSpreadMs}ms)
- 접수 p50/p95: ${result.submissionP50Ms}/${result.submissionP95Ms}ms
- k6 종료 코드: ${result.k6ExitCode}, 잘못된 이벤트 행: ${invalidLines}
- 연결 사전 준비: ${result.warmConnections}
- 조회 오류: ${JSON.stringify(result.polling.errors)}
- 접수 HTTP 분포: ${JSON.stringify(result.httpStatuses)}, 연결 오류 코드: ${JSON.stringify(result.transportErrors)}
- 기타 결과: ${JSON.stringify(Object.fromEntries(Object.entries(result.actual).filter(([key]) => !Object.hasOwn(plan.expected, key))))}
- 서버 시간(선택 DB 증거): ${JSON.stringify(result.serverTimings)}
\n완료 관측 시간에는 수집 시작 지연·조회 간격이 포함됩니다. 실제 서버 처리 시간과 구분하세요.
캐시/LLM/임계값 로그가 없거나 서로 모순되면 예상 그룹으로 추정하지 않습니다.
이 보고서에는 비밀번호·JWT·질문·답변 본문을 저장하지 않습니다.\n`);
  return result;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { logs: [] };
  for (let i = 0; i < rest.length; i += 2) {
    requireValue(rest[i]?.startsWith('--') && rest[i + 1] && !rest[i + 1].startsWith('--'), '옵션은 --이름 값 형식입니다.');
    const key = rest[i].slice(2);
    requireValue(['dir', 'run-id', 'base-url', 'questions', 'total', 'concurrency', 'start-delay-seconds',
      'max-start-spread-ms', 'warm-connections', 'k6', 'rps', 'max-wait-seconds', 'log', 'db-evidence'].includes(key), `알 수 없는 옵션: ${key}`);
    if (key === 'log') options.logs.push(resolve(rest[i + 1]));
    else options[key] = rest[i + 1];
  }
  requireValue(options.dir, '--dir 출력 디렉터리가 필요합니다.');
  return { command, options, directory: resolve(options.dir) };
}

export async function main(argv) {
  const { command, options: o, directory } = parseArgs(argv);
  switch (command) {
    case 'prepare': {
      requireValue(o['run-id'] && o['base-url'] && o.questions, '--run-id, --base-url, --questions가 필요합니다.');
      const plan = await prepare({ directory, runId: o['run-id'], baseUrl: o['base-url'], questions: await json(resolve(o.questions)),
        total: Number(o.total ?? 1500), concurrency: Number(o.concurrency ?? 4), password: process.env.UBOT_LOAD_PASSWORD });
      console.log(`회원·JWT 준비 완료: ${plan.total}명. 비밀 정보는 출력하지 않습니다.`);
      return 0;
    }
    case 'tokens': await issueTokens(directory, Number(o.concurrency ?? 4)); console.log('JWT 재발급 완료'); return 0;
    case 'run': {
      requireValue(!o['warm-connections'] || ['true', 'false'].includes(o['warm-connections']), 'warm-connections는 true 또는 false입니다.');
      return runBurst({ directory, startDelaySeconds: Number(o['start-delay-seconds'] ?? 15),
        maxStartSpreadMs: Number(o['max-start-spread-ms'] ?? 1000), warmConnections: o['warm-connections'] !== 'false', k6: o.k6 ?? 'k6' });
    }
    case 'collect': {
      const state = await collect({ directory, rps: Number(o.rps ?? 15), maxWaitSeconds: Number(o['max-wait-seconds'] ?? 1800) });
      console.log(`결과 수집: 미완료 ${state.pending}건. 로그를 확보한 뒤 report 명령으로 처리 경로를 검증하세요.`);
      return state.pending ? 1 : 0;
    }
    case 'report': {
      const result = await report({ directory, logs: o.logs, databaseEvidence: o['db-evidence'] ? resolve(o['db-evidence']) : undefined });
      console.log(JSON.stringify({ passed: result.passed, expected: result.expected, actual: result.actual,
        recorded: result.recorded, mismatches: result.mismatches, startSpreadMs: result.startSpreadMs }));
      return result.passed ? 0 : 1;
    }
    default: throw new Error('명령: prepare | tokens | run | collect | report. 사용법은 같은 폴더 README.md를 참고하세요.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
