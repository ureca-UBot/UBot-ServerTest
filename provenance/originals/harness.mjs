// 장애 검증 스크립트(worker·redis·postgres·vllm-crash)가 함께 쓰는 실행 환경과 보조 함수
// 실제 로컬 모델과 기존 전용 테스트 DB만 사용함. DB 상태나 복구 시계를 수정하지 않음
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { request } from '../chat-burst/cli.mjs';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const apiUrl = 'http://127.0.0.1:18080';
export const workerUrl = 'http://127.0.0.1:18081';
export const modelUrl = 'http://127.0.0.1:8000';
export const database = 'ubot-chat-burst-live-postgres-1';
export const redis = 'ubot-chat-burst-live-redis-1';
export const question = '분실한 유심을 재발급받으려면 어떻게 하나요?';
export const jar = 'build/libs/UBot-BE-0.0.1-SNAPSHOT.jar';
const java = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.11.10-hotspot\\bin\\java.exe';

export const timestamp = () => new Date().toISOString();
export const sha = data => createHash('sha256').update(data).digest('hex');

// 결과가 어떤 코드로 만들어졌는지 남기는 해시. 실행 스크립트와 이 공통 파일을 함께 넣음
export async function harnessSha256(script) {
  const path = script.startsWith('file:') ? fileURLToPath(script) : script;
  return sha(Buffer.concat([await readFile(path), await readFile(fileURLToPath(import.meta.url))]));
}

// --config의 결과 폴더(build 아래)를 새로 만들고 기록 함수를 돌려줌. 이미 있으면 실패함
export async function openRun(argv = process.argv) {
  assert.equal(argv[2], '--config');
  const config = JSON.parse((await readFile(resolve(argv[3]), 'utf8')).replace(/^\uFEFF/, ''));
  const directory = resolve(repo, config.directory);
  assert.ok(directory.startsWith(join(repo, 'build') + '\\'), '결과는 Git 제외 build 폴더에 저장합니다.');
  await mkdir(directory, { recursive: false });
  const write = (name, data) => writeFile(join(directory, name), JSON.stringify(data, null, 2) + '\n');
  const events = [];
  async function event(type, details = {}) {
    const entry = { type, at: timestamp(), ...details };
    events.push(entry);
    await write('events.json', events);
    console.log(JSON.stringify(entry));
  }
  return { config, directory, write, event };
}

export function docker(args, input) {
  return execFileSync('docker', args, { cwd: repo, input, encoding: 'utf8', timeout: 15000,
    maxBuffer: 16 * 1024 * 1024, windowsHide: true }).trim();
}

// 전용 테스트 DB에서 읽기 전용 트랜잭션으로 JSON 값 하나를 조회함
export function sql(statement) {
  return JSON.parse(docker(['exec', '-i', database, 'psql', '-U', 'burst', '-d', 'ubot_burst', '-qAt', '-v', 'ON_ERROR_STOP=1'],
    `BEGIN READ ONLY; SET LOCAL statement_timeout='10s';\n${statement}\nCOMMIT;`));
}

// worker·redis·postgres 장애 검증이 보는 작업 행. 답변 중복·빈 답변까지 함께 셈
export function jobRowsQuery(jobIds) {
  assert.equal(jobIds.length, 100);
  assert.equal(new Set(jobIds).size, 100);
  assert.ok(jobIds.every(id => Number.isSafeInteger(id) && id > 0));
  return `SELECT coalesce(json_agg(t ORDER BY t."jobId"), '[]'::json) FROM (
    SELECT j.job_id AS "jobId", j.attempt_id AS "attemptId", j.execution_status AS status,
      j.phase, a.status AS "attemptStatus", a.error_code AS "errorCode", a.attempt_count AS "attemptCount",
      a.user_id AS "userId", a.conversation_id AS "conversationId",
      extract(epoch FROM j.created_at AT TIME ZONE 'Asia/Seoul') * 1000 AS "createdAtMs",
      extract(epoch FROM j.started_at AT TIME ZONE 'Asia/Seoul') * 1000 AS "startedAtMs",
      extract(epoch FROM j.heartbeat_at AT TIME ZONE 'Asia/Seoul') * 1000 AS "heartbeatAtMs",
      extract(epoch FROM j.finished_at AT TIME ZONE 'Asia/Seoul') * 1000 AS "finishedAtMs",
      (SELECT count(*) FROM question_log q WHERE q.attempt_id=j.attempt_id) AS "answerRows",
      (SELECT count(*) FROM question_log q WHERE q.attempt_id=j.attempt_id AND q.sub_question_index=1) AS "turnRows",
      (SELECT count(*) FROM (SELECT sub_question_index FROM question_log q WHERE q.attempt_id=j.attempt_id
        GROUP BY sub_question_index HAVING count(*)>1) dup) AS "duplicateSubQuestions",
      (SELECT count(*) FROM question_log q WHERE q.attempt_id=j.attempt_id AND btrim(q.llm_question)='') AS "emptyAnswers"
    FROM chat_jobs j JOIN answer_attempts_history a ON a.attempt_id=j.attempt_id
    WHERE j.job_id IN (${jobIds.join(',')})
  ) t;`;
}

export function pending() {
  return JSON.parse(docker(['exec', redis, 'redis-cli', '--json', 'XPENDING', 'chat:jobs', 'chat-workers']));
}

export function redisCommand(args) {
  return docker(['exec', redis, 'redis-cli', ...args]);
}

// 발행 표시뿐 아니라 그 표시가 가리키는 Stream 메시지의 jobId까지 확인함
export function redisSnapshot(jobIds) {
  const script = `local marks=redis.call('MGET', unpack(KEYS,2)); local present=0; local matched=0;
    for i,mark in ipairs(marks) do if mark then present=present+1;
      local entries=redis.call('XRANGE', KEYS[1], mark, mark);
      if #entries>0 then local fields=entries[1][2]; for j=1,#fields,2 do
        if fields[j]=='jobId' and fields[j+1]==ARGV[i] then matched=matched+1; break; end end end
    end end
    return cjson.encode({marksPresent=present,messagesMatched=matched,streamLength=redis.call('XLEN',KEYS[1])})`;
  const state = JSON.parse(redisCommand(['--raw', 'EVAL_RO', script, String(jobIds.length + 1), 'chat:jobs',
    ...jobIds.map(id => `chat:jobs:published:${id}`), ...jobIds.map(String)]));
  const server = redisCommand(['INFO', 'server']);
  return { at: timestamp(), ...state, runId: server.match(/^run_id:(.+)$/m)?.[1].trim(),
    pending: pending() };
}

// Spring Boot JAR을 api·worker 역할로 띄움. 로그는 결과 폴더의 name.log에 남기고 owned에 등록함
export function startSpring({ directory, owned, role, name, consumer = name }) {
  const stdout = openSync(join(directory, `${name}.log`), 'wx');
  const stderr = openSync(join(directory, `${name}-error.log`), 'wx');
  const env = { ...process.env,
    SPRING_PROFILES_ACTIVE: 'local', APP_ROLE: role,
    POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '25432', POSTGRES_DB: 'ubot_burst',
    POSTGRES_USER: 'burst', POSTGRES_PASSWORD: 'local-burst-only',
    REDIS_HOST: '127.0.0.1', REDIS_PORT: '26379', SERVER_ADDRESS: '127.0.0.1',
    SERVER_PORT: role === 'api' ? '18080' : '18081',
    AI_MODE: 'vllm', AI_CHAT_ENGINE: '', AI_EMBEDDING_ENGINE: '',
    LLM_BASE_URL: 'http://127.0.0.1:8000/v1', LLM_MODEL: 'ubot-chat',
    EMBEDDING_BASE_URL: 'http://127.0.0.1:8001/v1', EMBEDDING_MODEL: 'ubot-embedding',
    FAQ_CACHE_ENABLED: 'true', CHAT_WORKER_CONCURRENCY: '4', LLM_MAX_CONCURRENT: '4',
    CHAT_WORKER_CONSUMER_NAME: consumer, CHAT_WORKER_HEARTBEAT_TIMEOUT: '1m',
    CHAT_WORKER_RECLAIM_IDLE: '5m', CHAT_WORKER_RECOVERY_INTERVAL: '15s',
    CHAT_WORKER_MAX_QUEUE_WAIT: '10m', CHAT_WORKER_EXECUTION_TIMEOUT: '180s', CHAT_WORKER_MAX_DELIVERIES: '3' };
  const child = spawn(java, ['-Xms512m', '-Xmx2g', '-jar', jar], { cwd: repo, env, windowsHide: true,
    stdio: ['ignore', stdout, stderr] });
  closeSync(stdout); closeSync(stderr);
  owned.push(child);
  child.on('error', error => { child.startError = error; });
  return child;
}

export async function ready(child, url) {
  for (let i = 0; i < 120; i++) {
    assert.ok(child.exitCode === null && !child.startError, '기동 중 프로세스가 종료됐습니다.');
    try {
      const r = await request(url, 'GET', '/actuator/health', undefined, undefined, 1500);
      if (r.status === 200 && r.body?.status === 'UP') return;
    } catch {
      // 기동 중 연결 거절은 readiness 대기임
    }
    await wait(500);
  }
  throw Error('프로세스 기동 제한을 초과했습니다.');
}

export async function metrics(url, path = '/actuator/prometheus') {
  const r = await fetch(url + path, { signal: AbortSignal.timeout(3000) });
  assert.equal(r.status, 200);
  return r.text();
}

export async function forceKill(owned, child) {
  assert.ok(owned.includes(child) && child.exitCode === null, '이 실행이 생성한 살아 있는 프로세스만 종료합니다.');
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, at: timestamp() })));
  // Windows TerminateProcess: Spring 종료 훅과 대기열 반납을 거치지 않음
  assert.equal(child.kill('SIGKILL'), true);
  return exited;
}

// 정리 단계에서 이 실행이 띄운 프로세스 중 살아 있는 것만 강제 종료함
export async function killRemaining(owned) {
  for (const child of owned) if (child.exitCode === null && child.signalCode === null) await forceKill(owned, child);
}

// running()이 false가 될 때까지 1초마다 health를 찍어 target에 쌓음
export async function healthLoop(url, target, running) {
  while (running()) {
    const began = Date.now();
    const probe = { at: timestamp() };
    try {
      const r = await request(url, 'GET', '/actuator/health', undefined, undefined, 2000);
      probe.httpStatus = r.status; probe.status = r.body?.status;
    } catch { probe.httpStatus = 0; probe.status = 'CLIENT_REQUEST_FAILED'; }
    probe.completedAt = timestamp(); probe.elapsedMs = Date.now() - began;
    target.push(probe);
    await wait(1000);
  }
}

export async function assertPortsFree() {
  for (const url of [apiUrl, workerUrl]) {
    const occupied = await fetch(url + '/actuator/health', { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
    assert.equal(occupied, false, `${url}에 기존 프로세스가 있습니다.`);
  }
}

export async function modelList() {
  return Promise.all([8000, 8001].map(async port => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(r.status, 200);
    return r.json();
  }));
}

// 준비된 합성 회원 100명으로 실제 로그인함. 토큰은 메모리에만 두고 결과 파일에 쓰지 않음
export async function loginMembers(config) {
  const credentials = JSON.parse((await readFile(resolve(repo, config.credentials), 'utf8')).replace(/^\uFEFF/, ''));
  const accounts = credentials.accounts.slice(0, 100).map(a => ({ email: a.email, userId: a.userId }));
  assert.equal(accounts.length, 100);
  assert.equal(new Set(accounts.map(a => a.userId)).size, 100);
  assert.ok(accounts.every(a => a.email.endsWith('@example.test')));
  for (let offset = 0; offset < 100; offset += 4) {
    await Promise.all(accounts.slice(offset, offset + 4).map(async a => {
      const r = await request(apiUrl, 'POST', '/auth/login', { email: a.email, password: credentials.password });
      assert.equal(r.status, 200);
      const claims = JSON.parse(Buffer.from(r.body.data.accessToken.split('.')[1], 'base64url'));
      assert.equal(claims.role, 'USER');
      assert.equal(Number(claims.sub), a.userId);
      a.token = r.body.data.accessToken;
    }));
  }
  return accounts;
}

// 한 회원당 질문 POST는 정확히 한 번. 장애 후에도 재접수/사용자 재시도 API를 호출하지 않음
export function submitQuestions(accounts) {
  return Promise.all(accounts.map(async (a, index) => {
    const startedAt = timestamp();
    const r = await request(apiUrl, 'POST', '/chat/questions', { question }, a.token, 30000);
    return { caseId: index + 1, userId: a.userId, startedAt, receivedAt: timestamp(), httpStatus: r.status, ...r.body?.data };
  }));
}
