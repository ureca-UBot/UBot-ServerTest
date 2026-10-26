# Discord 장애·복구 알림

기존 [BE PR #274](https://github.com/ureca-UBot/UBot-BE/pull/274)의 실제 Discord·Slack 수신 기록과, 그때 사용한 설정 생성기·검증기를 보관했습니다.

## 기존 실제 수신 기록

PR의 실행 기록은 Backend·Worker·PostgreSQL·Redis 장애 FIRING과 복구 RESOLVED 수신을 확인합니다. Discord RESOLVED까지 체크돼 있으며, AWS 배포 연결은 당시 미완료로 표시돼 있습니다. 따라서 이를 AWS Discord 수신 시험으로 기록하지 않았습니다.

원본 캡처는 PR에 첨부돼 있습니다. 새 알림을 이번 업로드 작업에서 외부 채널로 보내지는 않았습니다.

<img src="https://github.com/user-attachments/assets/2372e563-0d75-4c2c-89ad-8125871d50f0" width="600" alt="PR 274에 첨부된 기존 장애·복구 알림 수신 화면">

## 도구와 재검증

- `tools/deploy/render-alert-config.sh`: 환경값으로 Prometheus 규칙·Alertmanager 설정·채널별 secret 파일 생성
- `tools/deploy/tests/render-alert-config-test.sh`: 채널 선택·설정값 검증·실패 시 기존 파일 보존·secret 비노출·권한 검사
- `infra/prometheus/rules/ubot-alerts.yml.template`: Backend·Worker·DB·Redis·대기 지연·LLM 시간 초과 규칙
- `infra/alertmanager/alertmanager.yml.template`: FIRING/RESOLVED 전송 설정

2026-10-26에는 격리된 Ubuntu 24.04 컨테이너에서 렌더러 테스트를 다시 실행해 통과했습니다. 테스트에 쓰는 `discord-test-secret`·`slack-test-secret`은 코드에 명시된 가짜 값입니다. 실제 Webhook은 포함하지 않았습니다.

```powershell
docker run --rm -v "${PWD}/discord-alerts:/workspace:ro" -w /workspace ubuntu:24.04 bash tools/deploy/tests/render-alert-config-test.sh
```

[재검증 결과](results/20261026-renderer.json) · [설정·운영 방법](operations.md)
