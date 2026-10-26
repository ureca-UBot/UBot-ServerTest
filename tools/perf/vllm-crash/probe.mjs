import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as wait } from 'node:timers/promises';
import { request } from '../chat-burst/cli.mjs';

const { apiUrl, watched, foreign } = workerData;
let running = true;
const security = [];
async function observe(path, token) {
  const started = Date.now(); const value = { at: new Date().toISOString(), path };
  try {
    const response = await request(apiUrl, 'GET', path, undefined, token, 2000);
    Object.assign(value, { httpStatus: response.status, apiCode: response.body?.code,
      jobStatus: response.body?.data?.status, jobErrorCode: response.body?.data?.errorCode,
      retryable: response.body?.data?.retryable, healthStatus: path === '/actuator/health' ? response.body?.status : undefined });
  } catch { value.httpStatus = 0; }
  value.completedAt = new Date().toISOString(); value.elapsedMs = Date.now() - started;
  return value;
}
parentPort.on('message', message => {
  if (message === 'stop') running = false;
  if (message === 'check-security') security.push((async () => {
    const parts = watched[0].token.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    for (const [name, token, expectedStatus] of [['invalid-signature', parts.join('.'), 401],
      ['other-member', foreign.token, 404]]) {
      const value = await observe(`/chat/jobs/${watched[0].jobId}`, token);
      parentPort.postMessage({ kind: 'security', value: { name, expectedStatus, ...value } });
    }
  })());
});
await Promise.all([
  ...watched.map(({ jobId, token }) => (async () => {
    while (running) {
      parentPort.postMessage({ kind: 'job', value: { jobId, ...await observe(`/chat/jobs/${jobId}`, token) } });
      await wait(500);
    }
  })()),
  (async () => {
    while (running) {
      parentPort.postMessage({ kind: 'health', value: await observe('/actuator/health') });
      await wait(1000);
    }
  })()
]);
await Promise.all(security);
parentPort.postMessage({ kind: 'done' }); parentPort.close();
