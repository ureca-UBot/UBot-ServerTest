import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const cases = new SharedArray('burst cases', () => JSON.parse(open(__ENV.BURST_PLAN)).cases);
const members = new SharedArray('burst members', () => JSON.parse(open(__ENV.BURST_CREDENTIALS)).accounts);
const total = Number(__ENV.BURST_TOTAL);
const startAt = Number(__ENV.BURST_START_AT);
const maximumSkew = Number(__ENV.BURST_MAX_START_SPREAD_MS || 1000);
const httpTimeout = Number(__ENV.BURST_HTTP_TIMEOUT_SECONDS || 300);
const requests = new Counter('burst_requests');
const unexpected = new Counter('burst_unexpected');
const startSkew = new Trend('burst_start_skew_ms');

export const options = {
  scenarios: { burst: { executor: 'per-vu-iterations', vus: total, iterations: 1, maxDuration: `${httpTimeout + 180}s`, gracefulStop: '30s' } },
  maxRedirects: 0,
  summaryTrendStats: ['min', 'med', 'p(95)', 'max'],
  thresholds: { burst_requests: [`count==${total}`], burst_unexpected: ['count==0'],
    burst_start_skew_ms: [`max<${maximumSkew}`], checks: ['rate==1'] },
};

export function setup() {
  if (!Number.isInteger(total) || total !== cases.length || total !== members.length || total > 3000
      || !__ENV.BURST_BASE_URL || !Number.isFinite(startAt) || startAt - Date.now() < 1000) {
    throw new Error('plan/회원 수 또는 시작 시각이 올바르지 않습니다. cli.mjs run으로 실행하세요.');
  }
  return { warmAt: Date.now(), warmWindowMs: Math.max(0, startAt - Date.now() - 2000) };
}

export default function (data) {
  const index = exec.vu.idInTest - 1;
  const item = cases[index], member = members[index];
  let warmupStatus = null;
  if (__ENV.BURST_WARM_CONNECTIONS === 'true') {
    // 준비 GET은 시간차를 두고 수행함. 측정 대상 1500개의 질문 POST는 아래 공통 시각에 시작함
    sleep(Math.max(0, (data.warmAt + data.warmWindowMs * index / total - Date.now()) / 1000));
    const health = http.get(`${__ENV.BURST_BASE_URL}/notices`, {
      timeout: '30s', tags: { phase: 'connection_warmup', name: 'GET /notices (preparation)' },
      responseCallback: http.expectedStatuses(200),
    });
    warmupStatus = health.status;
    check(health, { 'connection warmup ready': () => health.status === 200 });
  }
  sleep(Math.max(0, (startAt - Date.now()) / 1000));
  const startedAt = Date.now();
  startSkew.add(startedAt - startAt);
  // 재전송하지 않음. 첫 질문 POST에는 클라이언트 멱등키 계약이 없음
  const response = http.post(`${__ENV.BURST_BASE_URL}/chat/questions`, JSON.stringify({ question: item.question }), {
    headers: { Authorization: `Bearer ${member.accessToken}`, 'Content-Type': 'application/json' },
    timeout: `${httpTimeout}s`, tags: { group: item.group, name: 'POST /chat/questions' },
    responseCallback: http.expectedStatuses(202, 400),
  });
  let body = null;
  try { body = response.json(); } catch (_) {
    // HTML·프록시 오류도 원래 HTTP 상태로 기록함
  }
  const accepted = response.status === 202 && body?.success === true && Number.isSafeInteger(body?.data?.jobId);
  const forbidden = response.status === 400 && body?.success === false && body?.code === 'FW-003';
  requests.add(1);
  unexpected.add(accepted || forbidden ? 0 : 1);
  check(response, { 'accepted or forbidden': () => accepted || forbidden });
  console.log(JSON.stringify({ type: 'chat-burst-submission', runId: __ENV.BURST_RUN_ID, caseId: item.caseId,
    startedAt, endedAt: Date.now(), elapsedMs: Date.now() - startedAt, httpStatus: response.status,
    code: body?.code ?? null, warmupStatus, transportErrorCode: response.status === 0 ? response.error_code || null : null,
    ...(response.status === 0 ? { transportError: response.error, transportTimings: response.timings } : {}),
    jobId: accepted ? body.data.jobId : null }));
}

export function handleSummary(data) {
  return { [__ENV.BURST_K6_SUMMARY]: JSON.stringify(data, null, 2) };
}
