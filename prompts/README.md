# `prompts/` — HEAD 오케스트레이션 프롬프트 자산

> [← 루트 README](../README.md)

이 폴더는 에이전트에게 주는 지시문 모음입니다. 여기서 HEAD는 사용자와 직접 대화하는 메인 대화를 뜻합니다. HEAD가 목적 합의와 최종 판정에 머물고, 세부 구현은 서브에이전트(HEAD가 띄운 하위 에이전트)나 다른 탭에 맡긴 뒤, 결과를 새 컨텍스트에서 검수하도록 하는 것이 이 자산들의 목적입니다.

코드가 이 폴더를 읽는 경로는 세 가지입니다.

- **세션 시작 훅**이 `HEAD_CORE.md` 하나만 대화에 넣습니다. Claude Code에서 이어 하기(resume)나 갈래 나누기(fork)로 시작한 세션에는 이미 들어 있으므로 다시 넣지 않고, 설정의 `headCoreEnabled`가 `false`이거나 프로젝트가 설정으로 제외되어 있으면 넣지 않습니다. 자세한 동작은 [`src/hooks/README.md`](../src/hooks/README.md)에 있습니다.
- **`cortex_prompt` 도구**(MCP 서버 `herdr-cortex`가 제공하는 도구)가 나머지 자산을 필요할 때 읽어 줍니다. 이 폴더 밖의 파일은 읽지 못합니다.
- **설치기**가 `skills/` 아래의 폴더를 Claude Code의 스킬 폴더에 `~/.claude/skills/cortex-<이름>/`으로 복사합니다. 복사한 폴더에는 `.herdr-cortex-managed` 표시 파일을 두며, 이 표시가 없는 같은 이름의 폴더는 덮어쓰지 않고, 제거할 때도 표시가 있는 폴더만 지웁니다.

이 폴더의 파일들은 도구를 서버 이름이 붙지 않은 이름(`memory_save`, `relay_send` 등)으로만 부릅니다. 테스트가 이 폴더의 모든 `.md` 파일에 서버 이름이 붙은 도구 이름이 없는지 확인하므로, 이 문서도 그렇게 씁니다.

---

## 설계 원리

이 자산들과 herdr-cortex의 기억 기능은 아래 네 가지 생각 위에 서 있습니다. 기억 문서는 결정·작업 기록·지식·할 일·기준선 하나를 담은 마크다운 파일 하나를 말합니다.

**컨텍스트는 기억이 아닙니다.** 에이전트는 매 턴 주어진 대화만 보고 다음 행동을 정합니다. 대화가 길어지면 지금 판단과 무관한 낡은 내용이 섞이고, 요약을 다시 요약하는 일이 거듭되면 처음 합의한 내용에서 조금씩 멀어집니다. 그래서 합의한 결정·기준선·할 일은 대화 밖의 마크다운 파일에 고정하고, 대화가 압축되거나 새로 시작될 때 그 요약과 직전 대화의 원문을 다시 넣습니다.

**HEAD는 판단에, 세부는 워커에.** 메인 대화(HEAD)는 목적 합의, 계획 확정, 결과 통합, 최종 판정에 머뭅니다. 세부 조사와 구현은 서브에이전트나 다른 탭에서 하고, 결과와 제약, 근거의 위치만 돌려받습니다. 구현 세부가 쌓여 판단이 좁아지는 것을 막기 위해서입니다.

**만든 쪽이 검수하지 않습니다.** 직접 만든 결과물은 만든 맥락을 모르는 새 컨텍스트(`independent-review`, `reviewer`)에서 검수하고, HEAD가 처음의 합의를 기준으로 받아들일지 정합니다. 완료는 보고가 아니라 실제 실행으로 증명합니다.

**지우지 않고 잇습니다.** 결정이 바뀌면 옛 문서를 지우지 않고 새 문서의 `supersedes`로 대체해 이력을 남깁니다([`src/core/README.md`](../src/core/README.md#supersedes-옛-문서를-대체하기)).

---

## 파일 구성

| 경로 | `cortex_prompt` 호출 | 역할 |
| :--- | :--- | :--- |
| **`HEAD_CORE.md`** | `kind: "core"` | 세션 시작 때 들어가는 29줄 원칙입니다. 해상도 분리, 시야 협소화 예방, 관측과 추론의 분리, 독립 검수, 실행 증명, 정본 보호를 다룹니다. |
| **`DEVELOPMENT_STANDARD.md`** | `kind: "standard"` | 구현과 리뷰에 함께 쓰는 7개 원칙입니다. |
| **`skills/start-job/SKILL.md`** | `kind: "skill", name: "start-job"` | 작업을 시작할 때 쓰는 절차: 목표 합의, 기존 기억 확인, 그리고 직접 실행·포크·`delegate`·`plan-run` 중 하나로 진행 |
| **`skills/product-planning/SKILL.md`** | `kind: "skill", name: "product-planning"` | 문제 정의, 사용자 가치, 유저플로우의 3단계 기획 |
| **`skills/delegate/SKILL.md`** | `kind: "skill", name: "delegate"` | 경계가 정해진 작업 하나를 워커에게 한 번 맡기고 결과를 회수하는 절차 |
| **`skills/independent-review/SKILL.md`** | `kind: "skill", name: "independent-review"` | 새 컨텍스트에서 하는 독립 검수. 출력은 `Verified Facts`, `Open Facts`, `Blockers`, `Minor Notes`, `Verdict`의 다섯 구획입니다. |
| **`skills/plan-run/SKILL.md`**, **`skills/plan-run/steps/01-ideation.md` ~ `08-next-direction.md`** | `kind: "skill", name: "plan-run"`, 단계는 `name: "plan-run/steps/01-ideation"` 등 | 여러 사이클에 걸친 8단계 계획·실행 절차 |
| **`agents/coder.md`** | `kind: "agent", name: "coder"` | 확정된 명세를 그대로 구현하는 워커. 명세에 모순이나 빠진 것이 있으면 `contract_conflict`로 보고합니다. |
| **`agents/developer.md`** | `kind: "agent", name: "developer"` | 정해진 경계 안에서 구현하고 실제 실행으로 증명하는 워커 |
| **`agents/reviewer.md`** | `kind: "agent", name: "reviewer"` | 파일을 고치지 않는 독립 검수자 |

스킬은 5개(`start-job`, `product-planning`, `delegate`, `independent-review`, `plan-run`), 워커 역할은 3개(`coder`, `developer`, `reviewer`)입니다. `HEAD_CORE.md` 외의 자산은 필요할 때 `cortex_prompt` 도구로 읽으며, Claude Code에는 설치할 때 스킬로도 복사됩니다.

`cortex_prompt`는 `kind`에 따라 파일을 찾습니다. `skill`은 `skills/<name>/SKILL.md`, 없으면 `skills/<name>.md`를 읽고, `agent`는 `agents/<name>.md`를, `standard`와 `core`는 이 폴더 바로 아래의 `<name>.md`를 읽습니다(`name`을 생략하면 각각 `DEVELOPMENT_STANDARD`, `HEAD_CORE`). `name`에 `..`이 들어 있거나 결과 경로가 이 폴더를 벗어나면 오류를 돌려줍니다.

---

## 기억 쓰기 규칙에 대한 표현

`HEAD_CORE.md`와 `skills/delegate/SKILL.md`는 "정본 기억 쓰기(`memory_save`, `memory_update`)는 HEAD만 한다"고 적습니다. 이것은 에이전트가 따라야 할 작업 규칙입니다. 서브에이전트의 쓰기 호출을 도구와 훅이 거부하기는 하지만, 그 거부는 실수를 막는 장치이지 보안 경계가 아닙니다. 호스트가 호출자 정보를 넘겨줄 때만 동작하고, 훅이 실패하면 호출이 그대로 통과하기 때문입니다. 두 파일에도 그렇게 적혀 있으며, 한계의 전체 목록은 서버 쪽 검사를 다루는 [`src/mcp/README.md`의 "서브에이전트 판정"](../src/mcp/README.md#서브에이전트-판정-issubagentcaller)과 훅 쪽 검사를 다루는 [`src/hooks/README.md`의 "PreToolUse: 도구 호출 직전의 검사"](../src/hooks/README.md#pretooluse-도구-호출-직전의-검사)에 있습니다.

---

## `plan-run`의 기준선 규약

`plan-run`은 진행 상황을 기억 문서로 남기며, 문서의 `branch` 값으로 단계를 구분합니다.

1. **최초 목적(`P0`)**: 사이클을 시작하기 전에 사용자와 합의한 목표를 `type: "baseline"`, `branch: "P0"`인 문서로 저장합니다. `memory_overview`와 세션 시작 주입은 `P0` 기준선을 다른 항목보다 먼저 보여 줍니다.
2. **사이클별 브랜치(`C{k}-*`)**: `C{k}-IDEATION`, `C{k}-PLAN`, `C{k}-PN`, `C{k}-R{k}`, `C{k}-SEED` 순으로 문서를 남기고 `derived_from`으로 앞 문서와 잇습니다. 이렇게 이어진 계보는 `memory_graph`의 `depth`를 8로 주면 한 번에 따라갈 수 있습니다(`depth`의 최댓값은 10).
3. **검수 격리와 재시도 상한**: 4단계(`04-plan-acceptance`)는 3단계(`03-minimum-plan-review`)의 검수 결론을 보지 않고 따로 판정합니다. 같은 단계의 보완(`LOCAL_CORRECTION`)은 요약에 `attempt: N/2`로 횟수를 적어, 압축이나 재시작 뒤에도 두 번의 상한을 지킬 수 있게 합니다.
4. **마감**: 8단계(`08-next-direction`)에서 `DONE`이 확정되면 HEAD가 중간 기준선 문서를 `memory_update`로 `archived` 또는 `done` 상태로 바꿉니다. 그래야 끝난 계획이 `memory_overview`에 남지 않습니다.

---

## 관련 테스트

- [`test/orchestration-prompts.test.mjs`](../test/orchestration-prompts.test.mjs): 모든 자산이 `cortex_prompt`로 읽히는지와 폴더 밖 경로가 거부되는지, `HEAD_CORE.md`의 줄 수(25~40줄)와 핵심 문구, 다섯 구획 검수 형식의 일관성, 기준선 계보를 `memory_graph`로 따라갈 수 있는지를 확인합니다. 같은 파일의 청정도 검사는 `prompts/`와 `src/core/`의 모든 파일, 그리고 루트 `README.md`에 개인 경로나 사용자 이름이 없는지를 봅니다.
- [`test/hooks-and-budget.test.mjs`](../test/hooks-and-budget.test.mjs): 스킬 폴더의 복사와 제거, 사용자가 만든 스킬 폴더를 건드리지 않는지
- [`test/installer.test.mjs`](../test/installer.test.mjs): 이 폴더의 파일이 MCP 서버 접두어가 붙은 도구 이름을 쓰지 않는지
