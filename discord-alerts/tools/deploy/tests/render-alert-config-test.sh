#!/usr/bin/env bash
# render-alert-config.sh가 올바른 값으로만 규칙·Alertmanager 설정·secret을 만들고, 틀린 값이면 파일을 건드리지 않는지 확인합니다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="${SCRIPT_DIR}/../render-alert-config.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
DISCORD='https://discord.com/api/webhooks/000000000000000000/discord-test-secret'
SLACK='https://hooks.slack.com/services/T000/B000/slack-test-secret'
OUT="${WORK}/out"
RULES="${OUT}/prometheus/ubot-alerts.yml"
CONFIG="${OUT}/alertmanager/alertmanager.yml"
DISCORD_SECRET="${OUT}/alertmanager/secrets/discord-webhook"
SLACK_SECRET="${OUT}/alertmanager/secrets/slack-webhook"

fail() { echo "FAIL: $1"; exit 1; }

# 알림을 켜고 Discord만 넣은 .env에 인자로 준 KEY=VALUE 줄을 덧붙입니다(같은 키는 마지막 값 사용).
write_env() {
  {
    echo 'ALERTS_ENABLED=true'
    echo "ALERT_DISCORD_WEBHOOK_URL=${DISCORD}"
    printf '%s\n' "$@"
  } > "${WORK}/alerts.env"
}

render() {
  bash "${RENDER}" "${WORK}/alerts.env" "${OUT}" > "${WORK}/render.log" 2>&1
}

# Webhook URL은 규칙·Alertmanager 설정·출력 어디에도 남으면 안 됩니다.
assert_no_secret_leak() {
  local file
  for file in "${RULES}" "${CONFIG}" "${WORK}/render.log"; do
    if [ -f "${file}" ] && grep -qE 'discord-test-secret|slack-test-secret' "${file}"; then
      fail "Webhook URL이 ${file##*/}에 남음"
    fi
  done
}

assert_secret() {
  [ "$(cat "$1")" = "$2" ] || fail "${1##*/} 내용이 Webhook URL과 다름"
  if [ "$(uname -s)" = Linux ]; then
    [ "$(stat -c '%a' "$1")" = 600 ] || fail "${1##*/} 권한이 600이 아님"
  fi
}

expect_failure() {
  local name="$1"
  shift
  write_env "$@"
  if render; then fail "${name}: 잘못된 값인데 성공함"; fi
  grep -q '알림 설정이 올바르지 않아 중단합니다' "${WORK}/render.log" || fail "${name}: 중단 이유를 알리지 않음"
  assert_no_secret_leak
}

# Discord만: 기본값과 덮어쓴 값이 규칙에 들어가고, 설정에는 Discord만 남습니다.
write_env 'ALERT_CHAT_QUEUE_OLDEST_SECONDS=300' 'ALERT_LLM_TIMEOUT_RATIO=0.1' 'ALERT_WORKER_JOB=ubot-backend' \
  'ALERT_BACKEND_DOWN_FOR="30s"'
render || fail "정상 값인데 실패함: $(cat "${WORK}/render.log")"
[ -f "${RULES}" ] || fail '규칙 파일이 없음'
if grep -qE '__[A-Z_]+__' "${RULES}"; then fail '채우지 않은 자리가 남음'; fi
grep -q 'max(chat_jobs_oldest_queued_seconds) > 300' "${RULES}" || fail '대기 기준값이 규칙에 없음'
grep -q ') > 0.1' "${RULES}" || fail 'LLM 비율 기준이 규칙에 없음'
grep -q 'up{job="ubot-backend"} == 0' "${RULES}" || fail 'Worker job 이름이 규칙에 없음'
grep -q 'for: 30s' "${RULES}" || fail '따옴표로 감싼 기간 값을 읽지 못함'
grep -q 'for: 2m' "${RULES}" || fail '기본 대기 지속 시간(2m)이 없음'
grep -Fq 'llm_requests_seconds_count{client="chat"}[5m]' "${RULES}" || fail '기본 채팅 LLM 계산 기간(5m)이 없음'
grep -Fq 'llm_requests_seconds_count{client="chat",outcome="timeout"}[5m]' "${RULES}" \
  || fail 'LLM 시간 초과 분자가 채팅 호출로 한정되지 않음'
if grep 'llm_requests_seconds_count' "${RULES}" | grep -qv 'client="chat"'; then
  fail 'LLM 알림의 분모·최소 호출 수에 가드 호출이 섞임'
fi
grep -q 'discord_configs:' "${CONFIG}" || fail 'Discord 설정이 없음'
if grep -q 'slack_configs:' "${CONFIG}"; then fail 'Webhook을 넣지 않은 Slack 설정이 남음'; fi
if grep -qE '# (BEGIN|END) ' "${CONFIG}"; then fail '채널 구간 표시가 남음'; fi
grep -q 'webhook_url_file: /run/secrets/ubot-alerts/discord-webhook' "${CONFIG}" || fail 'Discord secret 경로가 다름'
assert_secret "${DISCORD_SECRET}" "${DISCORD}"
[ ! -e "${SLACK_SECRET}" ] || fail 'Slack secret이 생김'
assert_no_secret_leak

# Discord와 Slack 둘 다: 두 채널 모두 받습니다.
write_env "ALERT_SLACK_WEBHOOK_URL=${SLACK}"
render || fail "두 채널인데 실패함: $(cat "${WORK}/render.log")"
grep -q 'discord_configs:' "${CONFIG}" || fail '두 채널인데 Discord 설정이 없음'
grep -q 'api_url_file: /run/secrets/ubot-alerts/slack-webhook' "${CONFIG}" || fail '두 채널인데 Slack 설정이 없음'
assert_secret "${DISCORD_SECRET}" "${DISCORD}"
assert_secret "${SLACK_SECRET}" "${SLACK}"
assert_no_secret_leak
cp "${RULES}" "${WORK}/rules.before"
cp "${CONFIG}" "${WORK}/config.before"

# 틀린 값은 모두 실패하고, 이미 만든 파일은 그대로 둡니다.
expect_failure '비율이 1보다 큼' 'ALERT_LLM_TIMEOUT_RATIO=1.5'
expect_failure '비율이 숫자가 아님' 'ALERT_LLM_TIMEOUT_RATIO=abc'
expect_failure '비율이 0' 'ALERT_LLM_TIMEOUT_RATIO=0'
expect_failure '잘못된 기간' 'ALERT_WORKER_DOWN_FOR=1minute'
expect_failure '0인 기간' 'ALERT_LLM_TIMEOUT_WINDOW=0m'
expect_failure '단위 없는 기간' 'ALERT_CHAT_QUEUE_FOR=120'
expect_failure '대기 기준이 0' 'ALERT_CHAT_QUEUE_OLDEST_SECONDS=0'
expect_failure '대기 기준이 음수' 'ALERT_CHAT_QUEUE_OLDEST_SECONDS=-1'
expect_failure '최소 호출 수가 숫자가 아님' 'ALERT_LLM_TIMEOUT_MIN_CALLS=ten'
expect_failure 'job 이름에 따옴표' 'ALERT_WORKER_JOB=ubot"} or vector(1) #'
expect_failure '켜기 값이 true/false가 아님' 'ALERTS_ENABLED=yes'
expect_failure '알림을 켰는데 Webhook 없음' 'ALERT_DISCORD_WEBHOOK_URL='
expect_failure 'Discord 자리표시자 그대로' 'ALERT_DISCORD_WEBHOOK_URL=replace-on-server'
expect_failure 'Slack 주소 형식 틀림' 'ALERT_SLACK_WEBHOOK_URL=hooks.slack.com/x'
cmp -s "${RULES}" "${WORK}/rules.before" || fail '실패한 실행이 기존 규칙 파일을 바꿈'
cmp -s "${CONFIG}" "${WORK}/config.before" || fail '실패한 실행이 기존 Alertmanager 설정을 바꿈'
assert_secret "${DISCORD_SECRET}" "${DISCORD}"
assert_secret "${SLACK_SECRET}" "${SLACK}"
if ls -A "${OUT}"/*/.render.* "${OUT}"/alertmanager/secrets/.render.* >/dev/null 2>&1; then fail '임시 파일이 남음'; fi

# Slack만: Discord 설정과 이전 Discord secret이 빠집니다.
write_env 'ALERT_DISCORD_WEBHOOK_URL=' "ALERT_SLACK_WEBHOOK_URL=${SLACK}"
render || fail "Slack만인데 실패함: $(cat "${WORK}/render.log")"
grep -q 'slack_configs:' "${CONFIG}" || fail 'Slack 설정이 없음'
if grep -q 'discord_configs:' "${CONFIG}"; then fail 'Webhook을 뺀 Discord 설정이 남음'; fi
[ ! -e "${DISCORD_SECRET}" ] || fail '이전 Discord secret이 남음'

# 알림을 끄면 Webhook 없이도 성공하고, 빈 규칙을 만들고, 이전 설정과 secret을 지웁니다.
printf '%s\n' 'ALERTS_ENABLED=false' > "${WORK}/alerts.env"
render || fail "꺼 둔 설정인데 실패함: $(cat "${WORK}/render.log")"
grep -qx 'groups: \[\]' "${RULES}" || fail '알림을 끄면 빈 규칙이어야 함'
[ ! -e "${CONFIG}" ] || fail '알림을 끄면 Alertmanager 설정을 지워야 함'
if [ -e "${SLACK_SECRET}" ] || [ -e "${DISCORD_SECRET}" ]; then fail '알림을 끄면 이전 secret을 지워야 함'; fi

echo 'render-alert-config 테스트 통과'
