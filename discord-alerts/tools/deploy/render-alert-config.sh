#!/usr/bin/env bash
# .env의 알림 설정을 검사하고 Prometheus 알림 규칙과 Alertmanager 설정·Webhook secret 파일을 만듭니다.
# usage: render-alert-config.sh <env-file> [output-dir]
#   output-dir 기본값은 저장소(배포 묶음) 루트의 .generated이고, Compose가 이 폴더를 마운트합니다.
#   <output-dir>/prometheus/ubot-alerts.yml               Prometheus 규칙(ALERTS_ENABLED=false면 빈 규칙)
#   <output-dir>/alertmanager/alertmanager.yml            Webhook URL을 넣은 채널(Discord·Slack)만 남긴 설정
#   <output-dir>/alertmanager/secrets/<채널>-webhook       채널별 Webhook URL(권한 600)
# 값이 하나라도 틀리면 아무 파일도 바꾸지 않고 1로 끝납니다. 배포는 컨테이너를 바꾸기 전에 이 스크립트를 실행합니다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RULES_TEMPLATE="${ROOT_DIR}/infra/prometheus/rules/ubot-alerts.yml.template"
ALERTMANAGER_TEMPLATE="${ROOT_DIR}/infra/alertmanager/alertmanager.yml.template"
CHANNELS=(discord slack)

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <env-file> [output-dir]" >&2
  exit 2
fi
ENV_FILE="$1"
OUT_DIR="${2:-${ROOT_DIR}/.generated}"
if [ ! -f "${ENV_FILE}" ]; then
  echo "env 파일이 없습니다: ${ENV_FILE}" >&2
  exit 2
fi
for template in "${RULES_TEMPLATE}" "${ALERTMANAGER_TEMPLATE}"; do
  if [ ! -f "${template}" ]; then
    echo "템플릿이 없습니다: ${template}" >&2
    exit 2
  fi
done

# .env를 source하지 않고 KEY=VALUE 줄만 읽습니다. 같은 키가 여러 번 있으면 마지막 값을 씁니다.
env_value() {
  local key="$1" default="$2" line value=""
  line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" | tail -n 1 || true)"
  if [ -n "${line}" ]; then
    value="${line#*=}"
    value="${value%$'\r'}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "${value}" in
      \"*\" | \'*\') value="${value:1:${#value}-2}" ;;
    esac
  fi
  printf '%s' "${value:-${default}}"
}

ALERTS_ENABLED="$(env_value ALERTS_ENABLED false)"
declare -A WEBHOOK_URLS=(
  [discord]="$(env_value ALERT_DISCORD_WEBHOOK_URL '')"
  [slack]="$(env_value ALERT_SLACK_WEBHOOK_URL '')"
)
WORKER_JOB="$(env_value ALERT_WORKER_JOB ubot-ai-worker)"
BACKEND_DOWN_FOR="$(env_value ALERT_BACKEND_DOWN_FOR 1m)"
WORKER_DOWN_FOR="$(env_value ALERT_WORKER_DOWN_FOR 1m)"
DEPENDENCY_DOWN_FOR="$(env_value ALERT_DEPENDENCY_DOWN_FOR 1m)"
CHAT_QUEUE_OLDEST_SECONDS="$(env_value ALERT_CHAT_QUEUE_OLDEST_SECONDS 120)"
CHAT_QUEUE_FOR="$(env_value ALERT_CHAT_QUEUE_FOR 2m)"
LLM_TIMEOUT_RATIO="$(env_value ALERT_LLM_TIMEOUT_RATIO 0.05)"
LLM_TIMEOUT_WINDOW="$(env_value ALERT_LLM_TIMEOUT_WINDOW 5m)"
LLM_TIMEOUT_FOR="$(env_value ALERT_LLM_TIMEOUT_FOR 5m)"
LLM_TIMEOUT_MIN_CALLS="$(env_value ALERT_LLM_TIMEOUT_MIN_CALLS 10)"

errors=()

# Prometheus 기간 하나(예: 30s, 1m, 2h). 0이나 단위를 섞은 값은 받지 않습니다.
require_duration() {
  [[ "$2" =~ ^[1-9][0-9]*(ms|s|m|h|d|w|y)$ ]] || errors+=("$1은 30s·1m·2h 같은 0보다 긴 기간이어야 합니다: '$2'")
}

require_positive_integer() {
  [[ "$2" =~ ^[1-9][0-9]*$ ]] || errors+=("$1은 1 이상의 정수여야 합니다: '$2'")
}

# 0보다 크고 1 이하인 소수(예: 0.05). 1은 100%입니다.
require_ratio() {
  [[ "$2" =~ ^(0\.[0-9]*[1-9][0-9]*|1(\.0+)?)$ ]] || errors+=("$1은 0보다 크고 1 이하인 비율이어야 합니다(예: 0.05): '$2'")
}

case "${ALERTS_ENABLED}" in
  true | false) ;;
  *) errors+=("ALERTS_ENABLED는 true 또는 false여야 합니다: '${ALERTS_ENABLED}'") ;;
esac
# 규칙의 job="..." 안에 그대로 들어가므로 따옴표·공백이 없는 이름만 받습니다.
[[ "${WORKER_JOB}" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || errors+=("ALERT_WORKER_JOB은 Prometheus job 이름이어야 합니다: '${WORKER_JOB}'")
require_duration ALERT_BACKEND_DOWN_FOR "${BACKEND_DOWN_FOR}"
require_duration ALERT_WORKER_DOWN_FOR "${WORKER_DOWN_FOR}"
require_duration ALERT_DEPENDENCY_DOWN_FOR "${DEPENDENCY_DOWN_FOR}"
require_positive_integer ALERT_CHAT_QUEUE_OLDEST_SECONDS "${CHAT_QUEUE_OLDEST_SECONDS}"
require_duration ALERT_CHAT_QUEUE_FOR "${CHAT_QUEUE_FOR}"
require_ratio ALERT_LLM_TIMEOUT_RATIO "${LLM_TIMEOUT_RATIO}"
require_duration ALERT_LLM_TIMEOUT_WINDOW "${LLM_TIMEOUT_WINDOW}"
require_duration ALERT_LLM_TIMEOUT_FOR "${LLM_TIMEOUT_FOR}"
require_positive_integer ALERT_LLM_TIMEOUT_MIN_CALLS "${LLM_TIMEOUT_MIN_CALLS}"

# 값을 넣은 채널만 씁니다. Webhook URL은 오류 메시지에도 남기지 않습니다.
enabled_channels=()
for channel in "${CHANNELS[@]}"; do
  url="${WEBHOOK_URLS[${channel}]}"
  [ -n "${url}" ] || continue
  if [[ "${url}" =~ ^https?://[^[:space:]]+$ ]]; then
    enabled_channels+=("${channel}")
  else
    errors+=("ALERT_${channel^^}_WEBHOOK_URL은 http(s):// 주소여야 합니다.")
  fi
done
if [ "${ALERTS_ENABLED}" = true ] && [ "${#enabled_channels[@]}" -eq 0 ] && [ "${#errors[@]}" -eq 0 ]; then
  errors+=("ALERTS_ENABLED=true면 ALERT_DISCORD_WEBHOOK_URL·ALERT_SLACK_WEBHOOK_URL 중 하나 이상이 있어야 합니다.")
fi

if [ "${#errors[@]}" -gt 0 ]; then
  echo "알림 설정이 올바르지 않아 중단합니다. 파일은 바꾸지 않았습니다." >&2
  printf ' - %s\n' "${errors[@]}" >&2
  exit 1
fi

RULES_DIR="${OUT_DIR}/prometheus"
ALERTMANAGER_DIR="${OUT_DIR}/alertmanager"
SECRETS_DIR="${ALERTMANAGER_DIR}/secrets"
mkdir -p "${RULES_DIR}" "${SECRETS_DIR}"

# 모든 파일을 임시 파일로 다 만든 뒤 바꿔 넣어, 반쯤 쓴 설정을 읽지 않게 합니다.
temps=()
trap 'rm -f "${temps[@]}"' EXIT
# 서브셸에서 부르면 목록에 남지 않으므로 결과는 NEW_TEMP로 돌려줍니다.
new_temp() {
  NEW_TEMP="$(mktemp "$1/.render.XXXXXX")"
  temps+=("${NEW_TEMP}")
}

new_temp "${RULES_DIR}"
rules_tmp="${NEW_TEMP}"
if [ "${ALERTS_ENABLED}" = true ]; then
  # 위에서 검사한 값은 숫자·영문·. _ -만 들어 있어 sed 치환에 안전합니다.
  sed -e "s|__BACKEND_DOWN_FOR__|${BACKEND_DOWN_FOR}|g" \
      -e "s|__WORKER_DOWN_FOR__|${WORKER_DOWN_FOR}|g" \
      -e "s|__WORKER_JOB__|${WORKER_JOB}|g" \
      -e "s|__DEPENDENCY_DOWN_FOR__|${DEPENDENCY_DOWN_FOR}|g" \
      -e "s|__CHAT_QUEUE_OLDEST_SECONDS__|${CHAT_QUEUE_OLDEST_SECONDS}|g" \
      -e "s|__CHAT_QUEUE_FOR__|${CHAT_QUEUE_FOR}|g" \
      -e "s|__LLM_TIMEOUT_RATIO__|${LLM_TIMEOUT_RATIO}|g" \
      -e "s|__LLM_WINDOW__|${LLM_TIMEOUT_WINDOW}|g" \
      -e "s|__LLM_TIMEOUT_FOR__|${LLM_TIMEOUT_FOR}|g" \
      -e "s|__LLM_MIN_CALLS__|${LLM_TIMEOUT_MIN_CALLS}|g" \
      "${RULES_TEMPLATE}" > "${rules_tmp}"
  if grep -qE '__[A-Z_]+__' "${rules_tmp}"; then
    echo "알림 규칙에 채우지 못한 자리가 남았습니다: $(grep -oE '__[A-Z_]+__' "${rules_tmp}" | sort -u | tr '\n' ' ')" >&2
    exit 1
  fi
else
  printf '%s\n' '# ALERTS_ENABLED=false라 알림 규칙을 비워 둡니다.' 'groups: []' > "${rules_tmp}"
fi
chmod 644 "${rules_tmp}"

if [ "${ALERTS_ENABLED}" = true ]; then
  # 쓰지 않는 채널의 # BEGIN·# END 구간을 지우고, 남은 표시 줄도 지웁니다.
  sed_args=()
  for channel in "${CHANNELS[@]}"; do
    if [ -z "${WEBHOOK_URLS[${channel}]}" ]; then
      sed_args+=(-e "/# BEGIN ${channel}\$/,/# END ${channel}\$/d")
    fi
  done
  sed_args+=(-e '/# BEGIN [a-z]*$/d' -e '/# END [a-z]*$/d')
  new_temp "${ALERTMANAGER_DIR}"
  alertmanager_tmp="${NEW_TEMP}"
  sed "${sed_args[@]}" "${ALERTMANAGER_TEMPLATE}" > "${alertmanager_tmp}"
  chmod 644 "${alertmanager_tmp}"

  declare -A secret_tmps=()
  for channel in "${enabled_channels[@]}"; do
    new_temp "${SECRETS_DIR}"
    secret_tmp="${NEW_TEMP}"
    (umask 077 && printf '%s' "${WEBHOOK_URLS[${channel}]}" > "${secret_tmp}")
    chmod 600 "${secret_tmp}"
    # Alertmanager 컨테이너는 nobody(65534)로 실행되므로 root로 만들 때는 소유자를 넘겨 600을 유지합니다.
    if [ "$(id -u)" -eq 0 ]; then
      chown 65534:65534 "${secret_tmp}"
    fi
    secret_tmps[${channel}]="${secret_tmp}"
  done
fi

# 여기부터 실제 파일을 바꿉니다.
mv -f "${rules_tmp}" "${RULES_DIR}/ubot-alerts.yml"
if [ "${ALERTS_ENABLED}" = true ]; then
  mv -f "${alertmanager_tmp}" "${ALERTMANAGER_DIR}/alertmanager.yml"
  for channel in "${CHANNELS[@]}"; do
    if [ -n "${secret_tmps[${channel}]:-}" ]; then
      mv -f "${secret_tmps[${channel}]}" "${SECRETS_DIR}/${channel}-webhook"
    else
      rm -f "${SECRETS_DIR}/${channel}-webhook"
    fi
  done
  echo "알림 설정을 만들었습니다: 채널=${enabled_channels[*]}, 출력=${OUT_DIR}"
else
  # 꺼 둘 때는 이전에 만든 Webhook URL을 서버에 남기지 않습니다.
  rm -f "${ALERTMANAGER_DIR}/alertmanager.yml"
  for channel in "${CHANNELS[@]}"; do
    rm -f "${SECRETS_DIR}/${channel}-webhook"
  done
  echo "알림이 꺼져 있어 빈 규칙만 만들었습니다: ${RULES_DIR}/ubot-alerts.yml"
fi
