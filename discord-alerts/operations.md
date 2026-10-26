# 장애 알림(Prometheus → Alertmanager → Discord·Slack)

애플리케이션은 지표만 내보냅니다. 장애 판단은 Prometheus 알림 규칙이, 묶기·중복 억제·채널 전송·복구 알림은 Alertmanager가 맡습니다. Java 코드는 알림을 알지 못합니다.

```
Backend / Worker / PostgreSQL / Redis ─▶ Prometheus ─┬─▶ 관리자 운영 모니터링
                                                     └─▶ 알림 규칙 ─▶ Alertmanager ─▶ Discord·Slack
```

## 알림 v1

| 알림 | 조건 | 심각도 | 런북 |
|---|---|---|---|
| `UBotBackendDown` | `up{job="ubot-backend"} == 0`이 `ALERT_BACKEND_DOWN_FOR` 동안 | critical | [backend-down](../runbooks/backend-down.md) |
| `UBotWorkerDown` | Worker job의 `up == 0` 또는 `chat_worker_ready == 0`이 `ALERT_WORKER_DOWN_FOR` 동안 | critical | [chat-worker-down](../runbooks/chat-worker-down.md) |
| `UBotPostgresDown` | `up{job="postgres"} == 0` 또는 `pg_up == 0`이 `ALERT_DEPENDENCY_DOWN_FOR` 동안 | critical | [postgres-down](../runbooks/postgres-down.md) |
| `UBotRedisDown` | `up{job="redis"} == 0` 또는 `redis_up == 0`이 `ALERT_DEPENDENCY_DOWN_FOR` 동안 | critical | [redis-down](../runbooks/redis-down.md) |
| `UBotChatQueueStalled` | `max(chat_jobs_oldest_queued_seconds)`가 `ALERT_CHAT_QUEUE_OLDEST_SECONDS`를 넘은 상태가 `ALERT_CHAT_QUEUE_FOR` 동안 | warning | [chat-queue-stalled](../runbooks/chat-queue-stalled.md) |
| `UBotLlmTimeoutRateHigh` | 최근 `ALERT_LLM_TIMEOUT_WINDOW` 동안 답변 생성·질문 분류(`client="chat"`) 호출이 `ALERT_LLM_TIMEOUT_MIN_CALLS`건 이상이고 시간 초과 비율이 `ALERT_LLM_TIMEOUT_RATIO`를 넘은 상태가 `ALERT_LLM_TIMEOUT_FOR` 동안. 가드 호출은 제외 | warning | [llm-timeout-high](../runbooks/llm-timeout-high.md) |

메시지 제목은 `[FIRING][CRITICAL] UBotWorkerDown` 형태이고, 복구되면 `[RESOLVED]…`가 옵니다. 같은 알림은 30초 모아 처음 보내고, 바뀐 내용은 5분마다, 계속 이어지면 4시간마다 다시 보냅니다(`infra/alertmanager/alertmanager.yml.template`).

## 알림 채널

Discord와 Slack을 지원합니다. `.env`에 Webhook URL을 넣은 채널로만 보내고, 둘 다 넣으면 두 채널 모두 받습니다.

- **Discord**: 알림을 받을 채널의 설정 → 연동 → 웹후크 → 새 웹후크 → 웹후크 URL 복사 → `ALERT_DISCORD_WEBHOOK_URL`. 서버에서 웹후크 관리 권한이 필요합니다.
- **Slack**: https://api.slack.com/apps?new_app=1 에서 앱을 만들고 Incoming Webhooks를 켠 뒤 채널을 골라 받은 주소 → `ALERT_SLACK_WEBHOOK_URL`.

Webhook URL은 비밀번호와 같습니다. 채팅·이슈·Git에 올리지 말고, 노출됐으면 채널 설정에서 지우고 다시 만듭니다.

## 설정

기준값은 `.env`의 `ALERTS_ENABLED`, `ALERT_*`로 정합니다([설정 Reference](../reference/configuration.md#개발-환경변수)). 애플리케이션을 다시 빌드할 필요는 없습니다.

Prometheus 규칙은 환경변수를 읽지 못하고 Alertmanager는 쓰지 않는 채널도 설정에 있으면 매번 전송에 실패하므로, 렌더러가 두 템플릿을 `.env` 값으로 채웁니다.

```bash
bash tools/deploy/render-alert-config.sh .env
```

- `.generated/prometheus/ubot-alerts.yml`: Prometheus가 `/etc/prometheus/rules`로 읽는 규칙. `ALERTS_ENABLED=false`면 빈 규칙입니다.
- `.generated/alertmanager/alertmanager.yml`: Webhook URL을 넣은 채널만 남긴 Alertmanager 설정.
- `.generated/alertmanager/secrets/<채널>-webhook`: 채널별 Webhook URL(권한 600). Alertmanager가 `/run/secrets/ubot-alerts`로 읽기 전용 마운트합니다. 빼거나 알림을 끄면 지웁니다.
- 값이 하나라도 틀리면(비율이 0~1 밖, `1minute` 같은 기간, 켰는데 Webhook 없음 등) 이유를 출력하고 아무 파일도 바꾸지 않은 채 1로 끝납니다. Webhook URL은 출력에 남기지 않습니다.
- `.generated/`는 Git에 올리지 않습니다. Webhook URL은 서버 `.env`에만 둡니다.
- Alertmanager는 `nobody`(65534)로 실행됩니다. Linux 서버에서는 렌더러를 root로 실행하면 secret 파일 소유자를 65534로 넘기고 600을 유지합니다. Docker Desktop(Windows)은 마운트 권한이 달라 따로 할 일이 없습니다.

값을 바꾼 뒤에는 설정을 다시 만들고 Prometheus와 Alertmanager를 재시작합니다.

## 로컬에서 확인

1. `.env`에 `ALERTS_ENABLED=true`와 Webhook URL을 넣습니다. 로컬은 백엔드 한 프로세스가 Worker도 맡으므로 `ALERT_WORKER_JOB=ubot-backend`입니다. 빨리 확인하려면 `ALERT_DEPENDENCY_DOWN_FOR=15s`처럼 줄입니다.
2. 설정을 만듭니다.

   ```bash
   bash tools/deploy/render-alert-config.sh .env
   ```

3. Alertmanager와 확인할 서비스를 띄웁니다. Alertmanager는 `alerts` 프로필이라 평소 `up`에는 뜨지 않습니다. 이미 떠 있던 Prometheus는 규칙을 다시 읽도록 재시작합니다.

   ```bash
   docker compose --profile alerts up -d redis redis-exporter prometheus alertmanager
   ```

4. Prometheus `http://localhost:19090/alerts`에서 규칙 6개를, Alertmanager `http://localhost:19093`에서 받은 알림을 확인합니다. 백엔드·PostgreSQL을 띄우지 않았다면 `UBotBackendDown`·`UBotWorkerDown`·`UBotPostgresDown`이 먼저 옵니다.
5. Redis를 멈추면(`docker compose stop redis`) 약 1분 뒤 `[FIRING][CRITICAL] UBotRedisDown`이, 다시 켜면 5분 안에 `[RESOLVED]`가 옵니다.
6. 끝나면 `docker compose --profile alerts down`으로 내립니다.

## 검사(CI)

`.github/workflows/alert-config.yml`이 PR마다 렌더러 테스트(`tools/deploy/tests/render-alert-config-test.sh`), shellcheck, Discord만·Slack만·둘 다인 Alertmanager 설정의 `amtool check-config`, `promtool check rules`·`check config`, Compose 설정을 검사합니다.

## v1에서 하지 않는 것

PagerDuty·SMS 같은 다른 채널, 알림에 따른 자동 복구, Alertmanager 이중화, SLO·Error Budget, 관리자 화면에서 기준값 수정, 알림 기록 저장. 기준값은 운영 설정이므로 서버 `.env`에서 바꿉니다.
