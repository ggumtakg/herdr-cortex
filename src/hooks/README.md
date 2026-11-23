# `src/hooks/` — Claude Code & Antigravity CLI 공식 훅 · 설치기

> [← 루트 README](../../README.md)

비공개 소켓이나 로그 해킹 없이 Claude Code와 Antigravity CLI의 **공식 훅 프로토콜**만으로 `HEAD_CORE.md` 주입, `memory_overview` 복구, 압축/`/clear` 직후 최근 5턴 원문 복원, 인박스 예산 우선 드레인, 서브에이전트 쓰기/세션 덮어쓰기 차단을 수행합니다.

---

## 파일 구성

| 파일 | 역할 | 주요 Export |
| :--- | :--- | :--- |
| **`claude.mjs`** | Claude Code 공식 훅 4종(`session-start`, `pre-compact`, `user-prompt`, `pre-tool-use`) 처리기 | `CLAUDE_HOOK_MAX_CHARS`, `COMPACT_POINTER_INSTRUCTION`, `isCortexToolName`, `handleClaudeSessionStart`, `handleClaudePreCompact`, `handleClaudeUserPrompt`, `handleClaudePreToolUse`, `runClaudeHook` |
| **`antigravity.mjs`** | Antigravity CLI 공식 훅 2종(`session-start`, `pre-invocation`) 처리기, 16KB 트랜스크립트 롤 프로브, 체크포인트 1회 복원 | `detectAntigravityTranscriptRole`, `handleAntigravitySessionStart`, `handleAntigravityPreInvocation`, `runAntigravityHook` |
| **`recent-turns.mjs`** | Claude/Antigravity 대용량 JSONL(2MB 초과 시 tail-read)에서 노이즈를 제거하고 최근 5턴 원문 및 `CHECKPOINT` 상태 추출 | `DEFAULT_MAX_TURNS`, `DEFAULT_RECENT_TURNS_BUDGET`, `DEFAULT_MAX_TAIL_BYTES`, `formatRecentTurns`, `extractClaudeRecentTurns`, `resolveAntigravityTranscriptPath`, `extractAntigravityState` |
| **`installer.mjs`** | Antigravity·Claude 훅/MCP 설정 병합, `.herdr-cortex.bak` 최초 1회 백업, Claude 스킬(`~/.claude/skills/cortex-*`) 동기화 및 멱등 제거 | `AGY_HOOK_KEY`, `LEGACY_AGY_HOOK_KEY`, `MCP_SERVER_KEY`, `CLAUDE_HOOK_MARKER`, `SKILL_MANAGED_MARKER`, `installCortex`, `uninstallCortex` |

---

## 호스트별 훅 동작 요약

### Claude Code (`claude.mjs`)
* **`SessionStart`** *(단일 통합 훅 호출)*: 서브에이전트 스킵 → `recordSession()` → `HEAD_CORE.md` + 인박스 부분 `ack` 드레인 + `memory_overview`(`p0Baselines` 포함) + (`/clear`·`compact` 시) 직전 5턴 원문을 9,000자 통합 예산 내 주입. 비-Herdr 일반 터미널 `/clear` 시에도 같은 디렉터리의 직전 `.jsonl`로 폴백 복원합니다.
* **`PreCompact`**: 서브에이전트 스킵 후 압축 직전 1줄 포인터 `systemMessage` 반환.
* **`UserPromptSubmit`**: 남은 예산 내에서 인박스 드레인 + 실제 전달된 메시지만 부분 `ack`.
* **`PreToolUse`**: 서브에이전트의 `memory_save`, `memory_update`, `relay_send`, `relay_inbox(ack)` 호출을 직접 `permissionDecision: "deny"`로 차단(정상 호출에는 불필요한 `allow` 미반환).

### Antigravity CLI (`antigravity.mjs`)
* **16KB 트랜스크립트 롤 프로브 (`detectAntigravityTranscriptRole`)**: 훅 stdin에 `rootConversationId`가 없어도 트랜스크립트 앞 16KB의 첫 스텝(`USER_INPUT`/`USER_EXPLICIT` vs `[Message] timestamp=... sender=<부모ID>`)으로 `'root'` / `'subagent'` / `'unknown'`을 판별합니다.
* `SessionStart`에서 `'unknown'`이면 주입·세션 기록을 `PreInvocation`으로 보류하고, `'subagent'`이면 아무것도 주입하지 않으며 부모 탭 세션 파일도 건드리지 않습니다.
* `PreInvocation`에서 첫 루트 호출 시 1회 `HEAD_CORE` + `overview` 주입, `/compact` 입력 시 1줄 포인터, 새로운 `CHECKPOINT(DONE)` 감지 시 1회 자동 복원, 예산 우선 부분 `ack` 인박스 드레인을 수행합니다.
* 미초기화 프로젝트에서는 체크포인트 상태 파일을 `~/.herdr-cortex/state/checkpoints/`에 저장해 불필요한 `.memory/` 생성을 막습니다.

### 대용량 JSONL 추출 (`recent-turns.mjs`)
* 2MB(`DEFAULT_MAX_TAIL_BYTES`) 초과 파일은 끝부분 2MB만 tail-read합니다.
* 노이즈 필터 정규식을 줄 시작(`^`)에 앵커링해 본문 중간에 `<command-name>`이 언급된 정상 발화를 보존하고, `User has answered`·연속 빈 `compact_boundary` 역탐색·초대형 단일 턴 앞/뒤 동시 보존을 처리합니다.

---

## 관련 테스트
* [`test/hooks-and-budget.test.mjs`](../../test/hooks-and-budget.test.mjs)
