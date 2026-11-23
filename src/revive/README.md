# `src/revive/` — Herdr 탭별 세션 기록

> [← 루트 README](../../README.md)

Herdr 탭마다 "지금 이 탭에서 어떤 에이전트의 어떤 대화가 어느 폴더에서 돌고 있는가"를 파일 하나로 기록해 두는 모듈입니다. PC를 다시 켜거나 Herdr를 다시 시작한 뒤 빈 셸로 돌아온 탭을 이전 대화로 되살리는 PowerShell 스크립트가 이 기록을 읽습니다. 되살리는 쪽의 동작(어떤 탭을 어떤 명령으로 복구하는지)은 [`scripts/README.md`](../../scripts/README.md)에 있고, 이 폴더는 기록을 쓰고 읽는 부분만 다룹니다.

탭은 Herdr가 주는 탭 ID(`t3` 등, 그 탭의 환경변수 `HC_TERMINAL_ID`)로 구분하고, 대화는 에이전트가 주는 세션 ID로 구분합니다.

---

## 파일 구성

| 파일 | 역할 | Export |
| :--- | :--- | :--- |
| **`tracker.mjs`** | 탭 ID·세션 ID 검증, 서브에이전트가 보낸 훅 입력 걸러내기, 탭별 세션 기록 쓰기·읽기·나열, 직전 세션 ID와 이력 유지, 홈 폴더와 전역 저장소 위치 결정의 창구 | `MAX_SESSION_HISTORY`, `isValidSessionId`, `isValidTerminalId`, `validateTerminalId`, `resolveEffectiveHome`, `resolveCortexGlobalDir`, `getSessionsDir`, `getLegacySessionsDir`, `isSubagentPayload`, `extractSessionId`, `extractCwd`, `readSavedSession`, `listSavedSessions`, `recordSession` |

---

## 저장 위치와 파일 형식

- 기록은 전역 저장소의 `sessions/` 폴더(`getSessionsDir()`, 기본 `~/.herdr-cortex/sessions/`)에 탭마다 `<탭 ID>.json` 하나로 저장합니다. 임시 파일에 쓴 뒤 이름을 바꾸는 방식이라 쓰다 만 파일이 남지 않습니다.
- 이전 도구(herdr-revive)가 쓰던 `~/.herdr-revive/sessions/`(`getLegacySessionsDir()`)는 읽기만 합니다. 새 위치에 기록이 없는 탭에 한해 거기서 읽고, 그 탭이 다음에 기록될 때 새 위치에 파일이 만들어집니다(직전 세션 ID와 이력은 옛 기록에서 이어받습니다). 옛 파일은 지우지 않습니다.

```json
{
  "terminalId": "t3",
  "agent": "claude",
  "sessionId": "0b0f6c1e-1111-2222-3333-444455556666",
  "previousSessionId": "9a8b7c6d-aaaa-bbbb-cccc-ddddeeeeffff",
  "history": ["9a8b7c6d-aaaa-bbbb-cccc-ddddeeeeffff"],
  "cwd": "C:\\Users\\<you>\\projects\\demo",
  "updatedAt": "2026-11-23T04:00:00.000Z"
}
```

| 필드 | 뜻 |
| :--- | :--- |
| `terminalId` | 탭 ID |
| `agent` | `claude` 또는 `antigravity`. `antigravity`가 아닌 값은 모두 `claude`로 기록합니다 |
| `sessionId` | 지금 이 탭의 세션 ID |
| `previousSessionId` | 이 탭에서 바로 전에 돌던 세션 ID(없으면 `null`) |
| `history` | 그보다 앞선 것까지 포함한 이전 세션 ID 목록. 최근 것이 앞이며 최대 `MAX_SESSION_HISTORY`(5)개 |
| `cwd` | 작업 폴더 |
| `updatedAt` | 기록한 시각(ISO 8601, UTC) |

---

## 동작

### ID 검증

탭 ID와 세션 ID는 파일 이름이 되고, 복구 스크립트에서는 명령줄 인자가 됩니다. 그래서 정해진 글자만 받습니다.

| 대상 | 규칙 | 함수 |
| :--- | :--- | :--- |
| 탭 ID | `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`이고 Windows 예약 이름(`con`, `prn`, `aux`, `nul`, `com1`~`com9`, `lpt1`~`lpt9`, 대소문자 무관)이 아님 | `isValidTerminalId`, `validateTerminalId`(맞지 않으면 예외) |
| 세션 ID | `^[a-zA-Z0-9._-]{1,128}$`이고 `..`을 포함하지 않음 | `isValidSessionId` |

`validateTerminalId`의 예외 문구는 `Invalid terminalId "<값>": must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ and not be a reserved name`입니다. 이 규칙 때문에 다른 PC의 탭 주소(`pc2/t3`)는 탭 ID로 받아들여지지 않습니다. [`src/relay/`](../relay/README.md)도 같은 함수로 탭 ID를 검증합니다.

### 기록하기 (`recordSession`)

`recordSession({ terminalId, agent, payload, sessionId, cwd, globalDir, legacyHome, now })`은 훅이 받은 입력(`payload`)에서 세션 ID와 작업 폴더를 꺼내 기록합니다. `terminalId`를 주지 않으면 환경변수 `HC_TERMINAL_ID`를 씁니다. 결과는 `{ recorded, reason, ... }`이며 `reason`은 다음 중 하나입니다.

| `reason` | `recorded` | 언제 |
| :--- | :---: | :--- |
| `subagent` | `false` | 입력이 서브에이전트의 것(아래) |
| `invalid_terminal_id` | `false` | 탭 ID가 없거나 규칙에 맞지 않음(Herdr 밖에서 실행한 에이전트 등) |
| `missing_session_id` | `false` | 입력에 세션 ID가 없음 |
| `invalid_session_id` | `false` | 세션 ID가 규칙에 맞지 않음 |
| `unchanged` | `false` | 새 위치에 이미 같은 `agent`·`sessionId`·`cwd`의 기록이 있음(파일을 다시 쓰지 않으므로 `updatedAt`도 그대로) |
| `saved` | `true` | 기록함. `filePath`와 `record`가 함께 옵니다 |

- 세션 ID는 입력의 `conversationId`, `conversation_id`, `session_id`, `sessionId` 순서로 찾습니다(`extractSessionId`도 같은 순서이며, 규칙에 맞지 않으면 빈 문자열을 돌려줍니다).
- 작업 폴더는 입력의 `cwd`, `workspacePaths[0]`, `workspacePath` 순서로 찾고 없으면 프로세스의 현재 폴더를 씁니다(`extractCwd`).
- 세션 기록은 프로젝트 제외 설정이나 승인 여부와 무관하게 이루어집니다. 기억 기능을 끈 프로젝트의 탭도 재부팅 뒤에 되살릴 수 있게 하기 위해서입니다.

### 서브에이전트의 입력은 기록하지 않음 (`isSubagentPayload`)

서브에이전트(메인 대화가 일을 맡기려고 띄운 하위 에이전트)도 같은 탭에서 훅을 실행합니다. 그 세션 ID가 기록되면 탭의 기록이 하위 에이전트의 대화로 덮여, 재부팅 뒤에 엉뚱한 대화가 복구됩니다. 그래서 입력에 다음 중 하나가 있으면 기록하지 않습니다.

- `agent_id` / `agentId`가 있음
- `is_subagent` / `isSubagent`가 `true`
- `parentConversationId` / `parent_conversation_id` / `parentSessionId` / `parent_session_id`가 있음
- `conversationId`(또는 `conversation_id`)와 `rootConversationId`(또는 `root_conversation_id`)가 둘 다 있고 서로 다름

이 판정은 호스트(Claude Code, Antigravity)가 훅 입력에 이런 정보를 넣어 줄 때만 동작합니다.

### `/clear` 뒤를 위한 직전 세션 기록 (`MAX_SESSION_HISTORY`)

Claude Code에서 `/clear`를 하면 같은 탭에서 새 세션 ID가 시작됩니다. 탭의 세션 ID가 바뀌는 순간 `recordSession`은 바뀌기 전의 ID를 `previousSessionId`에 넣고 `history`의 맨 앞에 추가합니다. `history`는 중복을 빼고 최근 `MAX_SESSION_HISTORY`(5)개만 남깁니다.

Claude Code의 세션 시작 훅은 이 `previousSessionId`로 "방금 지운 대화"의 기록 파일을 정확히 찾아 최근 대화를 복원합니다([`src/hooks/`](../hooks/README.md)). Herdr 밖에서 실행해 탭 ID가 없으면 이 기록이 없으므로 훅은 다른 방법(세션 종료 때 남긴 기록)으로 찾습니다.

### 읽기 (`readSavedSession`, `listSavedSessions`)

- `readSavedSession(탭 ID)`는 새 위치를 먼저 보고 없으면 옛 위치를 봅니다. 돌려주는 객체에는 어디서 읽었는지를 뜻하는 `source`(`cortex` 또는 `legacy`)가 붙습니다. 탭 ID가 규칙에 맞지 않거나 기록이 없으면 `null`입니다.
- `listSavedSessions()`는 두 위치의 기록을 합쳐(같은 탭이 양쪽에 있으면 새 위치의 것) `updatedAt`이 최근인 순서로 돌려줍니다. 파일 이름이 탭 ID 규칙에 맞지 않는 파일과 JSON 객체가 아닌 파일은 건너뜁니다.
- 다른 프로세스가 파일을 쓰는 중이라 읽기가 거부되면(`EBUSY`, `EPERM`, `EACCES`) 최대 6번 다시 읽습니다. 그래도 읽지 못하면 기록이 없는 것으로 봅니다.

### 홈과 전역 저장소 위치 (`resolveEffectiveHome`, `resolveCortexGlobalDir`)

두 함수는 [`src/core/`](../core/README.md)의 `resolveHomeDir`와 `resolveGlobalDir`를 그대로 부릅니다. 위치를 정하는 규칙은 그 한 곳에만 있고, 훅·릴레이·세션 기록이 모두 같은 결과를 씁니다.

| 함수 | 우선순위 |
| :--- | :--- |
| `resolveEffectiveHome(홈)` | ① 인자로 준 홈 → ② 환경변수 `HERDR_CORTEX_TEST_HOME`(이전 이름 `HERDR_REVIVE_TEST_HOME`도 같은 뜻) → ③ 사용자 홈 폴더 |
| `resolveCortexGlobalDir(전역 폴더)` | ① 인자로 준 폴더 → ② 환경변수 `HERDR_CORTEX_HOME` → ③ `<HERDR_CORTEX_TEST_HOME>/.herdr-cortex` → ④ `<사용자 홈>/.herdr-cortex` |

`HERDR_CORTEX_HOME`은 전역 저장소의 위치만 바꿉니다. 옛 기록 폴더 `.herdr-revive`는 홈 폴더 기준이므로 `HERDR_CORTEX_TEST_HOME`(또는 인자 `legacyHome`)을 따릅니다. `HERDR_CORTEX_TEST_HOME`은 테스트가 실제 홈을 건드리지 않게 하는 용도입니다.

---

## 누가 부르는가

| 호출하는 곳 | 쓰는 것 |
| :--- | :--- |
| Claude Code 세션 시작 훅 ([`src/hooks/claude.mjs`](../hooks/README.md)) | `recordSession`으로 기록하고, 결과의 `previousSessionId`로 `/clear` 직전 대화를 찾습니다 |
| Antigravity 세션 시작·호출 전 훅 ([`src/hooks/antigravity.mjs`](../hooks/README.md)) | 메인 대화로 확인된 호출에서 `recordSession` |
| [`scripts/record-session.mjs`](../../scripts/README.md) | 이전 방식의 훅이나 수동 호출을 위한 래퍼. `node scripts/record-session.mjs <antigravity\|claude>`로 실행하면 표준 입력의 JSON을 `recordSession`에 넘기고, 어떤 경우에도 종료 코드 0으로 끝납니다(`antigravity`일 때는 `{}`를 출력) |
| 릴레이 도구 ([`src/relay/`](../relay/README.md)) | `listSavedSessions`·`readSavedSession`으로 탭의 저장된 세션과 작업 폴더를 조회하고, `validateTerminalId`·`resolveCortexGlobalDir`로 받은편지함 경로를 만듭니다 |
| 복구 스크립트 ([`scripts/README.md`](../../scripts/README.md)) | 이 모듈을 부르지 않고 `sessions/`의 JSON 파일을 직접 읽습니다. 그래서 파일 형식과 ID 규칙이 양쪽의 약속입니다 |

---

## 한계와 확인 상태

- 이 기록으로 탭을 되살리는 쪽의 한계(폴더가 같은지를 경로 문자열로 비교함, 탭 제목으로 추측하는 복구는 그 탭의 대화가 아닐 수 있음)는 [`scripts/README.md`의 "한계"](../../scripts/README.md#한계)에 있습니다.
- Claude Code 2.1.330의 실제 세션에서 훅이 이 기록 파일(`sessions/<탭 ID>.json`)을 쓰는 것은 확인했습니다([`src/hooks/README.md`의 "확인 상태"](../hooks/README.md#확인-상태)). 재부팅 뒤 실제 Herdr 탭에서 이 기록으로 대화가 복구되는 것은 확인하지 못했으며, 그 항목은 [`scripts/README.md`의 "확인 상태"](../../scripts/README.md#확인-상태)에 있습니다.
- Antigravity 쪽의 동작은 개발에 쓴 PC에 Antigravity가 설치되어 있지 않아 코드와 자동 테스트로만 확인했습니다([`src/hooks/README.md`의 "확인 상태"](../hooks/README.md#확인-상태)의 "Antigravity CLI 전반").

---

## 관련 테스트

이 폴더의 모듈을 직접 불러 쓰는 테스트 파일입니다.

| 테스트 | 불러오는 것 |
| :--- | :--- |
| [`test/hooks-and-budget.test.mjs`](../../test/hooks-and-budget.test.mjs) | `isSubagentPayload`, `listSavedSessions`, `readSavedSession`, `recordSession` |
| [`test/home-isolation.test.mjs`](../../test/home-isolation.test.mjs) | `getLegacySessionsDir`, `resolveCortexGlobalDir`, `resolveEffectiveHome` |
| [`test/relay-inbox.test.mjs`](../../test/relay-inbox.test.mjs) | `recordSession` |
