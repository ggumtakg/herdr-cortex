# `src/revive/` — Herdr 탭 세션 추적 & 재부팅 복구 저장소

> [← 루트 README](../../README.md)

Herdr 터미널 탭(`HC_TERMINAL_ID`)별로 현재 실행 중인 `antigravity` 또는 `claude` 대화 세션 ID와 작업 디렉터리(`cwd`)를 안전하게 추적해, PC 재부팅이나 Herdr 재시작 후 [`scripts/revive-agents.ps1`](../../scripts/README.md)가 빈 셸 탭을 이전 대화로 복원할 수 있게 합니다.

---

## 파일 구성

| 파일 | 역할 | 주요 Export |
| :--- | :--- | :--- |
| **`tracker.mjs`** | 세션 ID/터미널 ID 엄격 검증, 서브에이전트 페이로드 차단, `~/.herdr-cortex/sessions/<terminalId>.json` 원자 저장, `/clear` 이전 `previousSessionId` 및 최대 이력 체인 유지, 레거시 `~/.herdr-revive/sessions/` 읽기 폴백 | `MAX_SESSION_HISTORY`, `isValidSessionId`, `isValidTerminalId`, `validateTerminalId`, `resolveEffectiveHome`, `resolveCortexGlobalDir`, `getSessionsDir`, `getLegacySessionsDir`, `isSubagentPayload`, `extractSessionId`, `extractCwd`, `readSavedSession`, `listSavedSessions`, `recordSession` |

---

## 핵심 안전장치

1. **서브에이전트 덮어쓰기 차단 (`isSubagentPayload`)**: `agent_id`, `is_subagent`, `parentConversationId`, `parent_session_id`, `conversation_id !== root_conversation_id` 등이 포함된 호출은 세션 기록을 건너뛰어 부모 HEAD 탭의 세션 ID를 보호합니다.
2. **명령 주입 방어 (`isValidSessionId`, `isValidTerminalId`)**: 세션 ID와 터미널 ID를 안전한 문자 집합으로 엄격 검증해 PowerShell 재실행 시 인자 주입을 차단합니다.
3. **`/clear` 이전 세션 체인**: 같은 탭에서 세션 ID가 교체되면 직전 ID를 `previousSessionId`와 `history`(최대 `MAX_SESSION_HISTORY = 5`개)에 보관해 `/clear` 직후 직전 5턴 원문 복원에 활용합니다.
4. **레거시 호환 폴백**: `~/.herdr-cortex/sessions/`에 아직 기록되지 않은 탭은 기존 `~/.herdr-revive/sessions/`에서 읽기 폴백합니다.

---

## 관련 테스트
* [`test/hooks-and-budget.test.mjs`](../../test/hooks-and-budget.test.mjs)
