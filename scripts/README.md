# `scripts/` — Windows 11 PowerShell 운영 · 복구 · 진단 스크립트

> [← 루트 README](../README.md)

Windows PowerShell 5.1 / PowerShell 7+ 환경에서 Herdr 탭 자동 복구, 통합 상태 진단(`cortex-status`), 그리고 레거시 호환 CLI 래퍼를 제공합니다. 루트 [`install.ps1`](../install.ps1)이 사용자의 `$PROFILE`에 UTF-8 BOM으로 `auto-revive.ps1` 로더 블록을 등록합니다.

---

## 파일 구성

| 파일 | 실행 환경 | 역할 |
| :--- | :---: | :--- |
| **`auto-revive.ps1`** | PowerShell `$PROFILE` | 터미널 시작 시 자동 복구 훅(옵션) + 전역 명령어 `cortex-status`, `revive-agents`(`revive-agy` 별칭 포함), `revive-status` 정의 |
| **`revive-agents.ps1`** | PowerShell CLI | `hc ls --json`으로 빈 셸 상태인 Herdr 탭을 찾아 저장된 `antigravity`/`claude` 세션을 일괄 복원 (`-DryRun` 지원, 세션 ID 엄격 검증, UTF-8 출력 고정) |
| **`merge-hooks.mjs`** | Node.js ESM | [`src/hooks/installer.mjs`](../src/hooks/README.md)로 위임하는 하위 호환 설치/제거 래퍼 (`node scripts/merge-hooks.mjs <install\|uninstall> [repoRoot]`) |
| **`record-session.mjs`** | Node.js ESM | [`src/revive/tracker.mjs`](../src/revive/README.md)로 위임하는 하위 호환 세션 기록 래퍼 (`node scripts/record-session.mjs <antigravity\|claude>`) |

---

## 주요 PowerShell 명령어

```powershell
# 현재 환경 통합 진단 (어느 폴더에서 실행해도 repoRoot 기준 sqlite-vec 정상 확인)
cortex-status

# 빈 셸 상태인 모든 Antigravity / Claude 탭 일괄 복구
revive-agents

# 실제 명령 전송 없이 복구 대상과 명령어만 미리 보기
revive-agents -DryRun

# 살아 있는 Herdr 터미널 상태 및 저장된 세션 ID 확인
revive-status
```

### `cortex-status` 진단 항목
* 기본 경로 및 세션: `Repo Root`, `Global Store`, `Saved Sessions` (`cortex` / `legacy` 개수), `HC_TERMINAL_ID`(설정된 경우)
* 런타임 환경: Node.js 버전 (`>=22.13` 검증) 및 `sqlite-vec` 로드 가능 여부(`createRequire(repoRoot/package.json)` 해석)
* 현재 디렉터리(`CWD`) 스코핑 정책: `enabled`, `mode`, `excludedProjects`/`enabledProjects` 일치 사유, `headCore`, `hookBudget`, `embed`
* 저장소 진단: 프로젝트(`.memory/`) · 전역(`~/.herdr-cortex/`) SQLite/WAL 크기 및 임베딩 상태 분포(`ready`/`pending`/`error` + 최근 에러) + 프로젝트 전용 상태(`inbox_pending`, `inbox_broken`, `orphan_tmp`)
* 설정 및 Herdr 상태: Antigravity & Claude Code 훅·MCP 설정 연결 상태, 그리고 `hc`가 `PATH`에 있을 때 라이브 Herdr 탭 상태(`revive-agents.ps1 -Status`)

---

## 환경변수 옵션
* `HERDR_REVIVE_DISABLE=1`: 프로필 로드 시 자동 복구만 비활성화(`install.ps1 -NoAutoResume`가 자동 설정)
* `HERDR_CORTEX_TEST_HOME` / `HERDR_REVIVE_TEST_HOME`: 격리된 임시 홈 디렉터리에서 설치·제거 테스트 시 사용
