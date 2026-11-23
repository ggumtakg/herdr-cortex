# `src/mcp/` — Stdio MCP 서버 (`cortex`) & 도구 레지스트리

> [← 루트 README](../../README.md)

외부 SDK 의존성 없이 Node.js 표준 입출력(`stdin`/`stdout`)으로 동작하는 JSON-RPC 2.0 Stdio MCP 서버(`cortex`)와 메모리·프롬프트 도구 레지스트리입니다. Claude Code와 Antigravity CLI가 동일한 10개 도구를 공유합니다.

---

## 파일 구성

| 파일 | 역할 | 주요 Export |
| :--- | :--- | :--- |
| **`server.mjs`** | JSON-RPC 2.0 Stdio 서버(`initialize`, `tools/list`, `tools/call`, `ping`, `notifications/roots/list_changed`), 비동기 임베딩 큐 연동 및 종료 시 `drain(3000)` | `SERVER_INFO`, `DEFAULT_PROTOCOL_VERSION`, `SERVER_INSTRUCTIONS`, `EXCLUDED_SERVER_INSTRUCTIONS`, `createMcpServer` |
| **`tools.mjs`** | 메모리 도구 6종 + `cortex_prompt` 1종 구현, 서브에이전트 정본 쓰기 차단(`SUBAGENT_WRITE_DENIED`), 제외 프로젝트 차단(`PROJECT_EXCLUDED`), `project_dir` 지원 | `isSubagentCaller`, `createToolRegistry` |

> 나머지 3개 릴레이 도구(`relay_tabs`, `relay_send`, `relay_inbox`)는 [`src/relay/tools.mjs`](../relay/README.md)에서 생성되어 `server.mjs`의 레지스트리에 통합됩니다.

---

## 등록되는 MCP 도구 10종

| 분류 | 도구명 | 쓰기 보호 | 비고 |
| :--- | :--- | :---: | :--- |
| **메모리** | `memory_search`, `memory_read`, `memory_graph`, `memory_overview` | 읽기 | 선택적 `project_dir` 지원 |
| **메모리** | `memory_save`, `memory_update` | **HEAD 전용** | 선택적 `project_dir` 지원, `derived_from` 단일 배열 스키마(Antigravity 호환) |
| **릴레이** | `relay_tabs` | 읽기 | Herdr 탭 + 저장 세션 + 인박스 대기 수 통합 조회 |
| **릴레이** | `relay_send` | **HEAD 전용** | 타깃 프로젝트 인박스 원자 저장 + `hc send --if idle` |
| **릴레이** | `relay_inbox` | 읽기 / **`ack` HEAD 전용** | `action: "peek" \| "ack"` |
| **프롬프트** | `cortex_prompt` | 읽기 | `kind: "core" \| "standard" \| "skill" \| "agent"`, 경로 탈출(`..`) 차단 |

---

## 보안 · 런타임 가드

1. **정본 보호 (`isSubagentCaller`)**: MCP `_meta`의 `agent_id`, `is_subagent`, `parentConversationId`, `parent_session_id`, `conversation_id !== root_conversation_id` 또는 `_caller_agent_id`가 감지되면 쓰기 도구를 `SUBAGENT_WRITE_DENIED`로 차단합니다.
2. **제외 프로젝트 강제 (`PROJECT_EXCLUDED`)**: 현재 프로젝트가 `excludedProjects` 또는 `opt-in` 미등록 상태이면 `initialize` 단계에서 `EXCLUDED_SERVER_INSTRUCTIONS`를 내려주고, 프로젝트 스코프 메모리 작업을 `PROJECT_EXCLUDED`로 거부합니다(`scope="global"`과 `cortex_prompt`만 허용).
3. **표준 에러 처리**: 도구 핸들러 내부 예외 발생 시 서버가 크래시하지 않고 JSON-RPC `-32603` 에러를 반환하며, `notifications/roots/list_changed` 알림을 오류 없이 정상 수신합니다.

---

## 실행 및 관련 테스트
```powershell
npm run mcp
```
* [`test/orchestration-prompts.test.mjs`](../../test/orchestration-prompts.test.mjs)
* [`test/relay-inbox.test.mjs`](../../test/relay-inbox.test.mjs)
* [`test/store-and-db.test.mjs`](../../test/store-and-db.test.mjs)
