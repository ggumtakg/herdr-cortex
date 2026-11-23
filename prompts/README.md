# `prompts/` — 2계층 HEAD 오케스트레이션 자산

> [← 루트 README](../README.md)

메인 대화(HEAD)가 저·중해상도 제어 평면에 머물면서 기억 우선 탐색, 경계 위임, 다사이클 계획-실행, 편향 없는 독립 검수를 일관되게 수행하도록 설계된 프롬프트 자산 모음입니다.
상시 주입되는 `HEAD_CORE.md`(29줄) 외의 모든 스킬·개발 기준·워커 역할은 작업 형태가 정해질 때 `cortex_prompt` MCP 도구로 온디맨드 로드합니다(Claude Code에는 설치 시 `~/.claude/skills/cortex-*`로도 동기화됩니다).

---

## 디렉터리 & 파일 구성

| 경로 | `cortex_prompt` 호출 예 | 역할 |
| :--- | :--- | :--- |
| **`HEAD_CORE.md`** | `kind: "core"` | 훅으로 상시 주입되는 29줄 핵심 원칙 (해상도 분리, 시야 협소화 예방, 관측/추론 분리, 독립 검수 의무, 실행 증명, 정본 보호) |
| **`DEVELOPMENT_STANDARD.md`** | `kind: "standard"` | 구현·리뷰 공통 7원칙 (오버엔지니어링·커버리지 집착 배제, 발견 없음 = 정상 `Clean Evaluation`) |
| **`skills/start-job/SKILL.md`** | `kind: "skill", name: "start-job"` | 작업 진입 게이트: 목표 합의 → 기억 우선 탐색 → 직접 실행 / 포크 / `delegate` / `plan-run` 라우팅 |
| **`skills/product-planning/SKILL.md`** | `kind: "skill", name: "product-planning"` | 문제 정의 → 사용자 가치 → 유저플로우(자동화 vs 사용자 통제 경계) 3단계 기획 |
| **`skills/delegate/SKILL.md`** | `kind: "skill", name: "delegate"` | 1회성 경계 위임 (작업 유형 혼합 금지 + Entry Contract 5요소 + 워커 역할 로드 + 패키징 재통합) |
| **`skills/independent-review/SKILL.md`** | `kind: "skill", name: "independent-review"` | 새 컨텍스트 독립 검수 — 5구획(`Verified Facts` / `Open Facts` / `Blockers` / `Minor Notes` / `Verdict`) 통일 출력 |
| **`skills/plan-run/SKILL.md`** + **`steps/01~08.md`** | `kind: "skill", name: "plan-run"` (또는 `plan-run/steps/01-ideation` 등) | 호스트 중립 8단계 다사이클 파이프라인 (`01-ideation` ~ `08-next-direction`) |
| **`agents/coder.md`** | `kind: "agent", name: "coder"` | 확정 명세 충실 구현 워커 (명세 모순·누락 시 `contract_conflict` 즉시 보고) |
| **`agents/developer.md`** | `kind: "agent", name: "developer"` | 경계 내 E2E 구현 + 실제 실행 증명 워커 |
| **`agents/reviewer.md`** | `kind: "agent", name: "reviewer"` | 파일 수정 권한 0의 독립 비평가 (5구획 검수 출력 + `Clean Evaluation` 지지) |

---

## `plan-run` 8단계 다사이클 기준선 규약

1. **최초 목적 보호 (`P0`)**: 사이클 시작 전 사용자 합의 목표를 `type: "baseline", branch: "P0"`로 고정합니다(`memory_overview`의 `p0Baselines`가 항상 최우선 노출).
2. **사이클 번호 브랜치 (`C{k}-*`)**: `C{k}-IDEATION` → `C{k}-PLAN` → `C{k}-PN` → `C{k}-R{k}` → `C{k}-SEED`로 브랜치 충돌을 막고 `derived_from` 링크로 `memory_graph(depth: 8)` 계보를 유지합니다.
3. **검수 격리 & 재시도 상한**: 4단계(`04-plan-acceptance`)는 3단계(`03-minimum-plan-review`)의 검수 결론을 보지 않은 상태로 독립 판정하며, `LOCAL_CORRECTION`은 `attempt: N/2`로 상한을 관리합니다.
4. **마감 청결 유지**: 8단계(`08-next-direction`)에서 `DONE`이 확정되면 HEAD가 중간 `baseline` 문서를 `memory_update(status: "archived" / "done")`로 마감해 `memory_overview`가 오래된 계획으로 오염되지 않게 유지합니다.

---

## 관련 테스트
* [`test/orchestration-prompts.test.mjs`](../test/orchestration-prompts.test.mjs) (자산 로드 · 5구획 일관성 · 다사이클 5홉 계보 · 저장소 청정도 검사)
