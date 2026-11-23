# 01. 단기 목표 도출 (Ideation)

## Trigger (진입 조건)

- `plan-run` 1사이클 시작 시(`P0` 최초 확정 필요), 또는 `08-next-direction`에서 `NEXT_CYCLE`로 새 `SEED` 기준선이 생성된 직후 진입한다.

## Inputs (입력)

- 사용자와 합의된 최초 목적·제약·성공 기준(1사이클) 또는 기존 `P0_ID`와 최신 `SEED_ID`(2사이클 이후).
- `memory_overview(session)` 및 `memory_search(session)` 결과로 확인한 현재 활성 결정·열린 `todo`.

## Execution (수행 절차)

1. 1사이클이라면 HEAD가 최초 목적 기준선 `P0`를 먼저 고정한다(`SEED_ID = P0_ID`).
2. `memory_read(id: SEED_ID, include_neighbors: true)`로 현재 출발점과 직전 사이클 제약·미해결 항목을 확인한다.
3. `P0`를 향해 이번 단일 사이클에서 달성할 **가장 작고 검증 가능한 단기 목표**를 도출한다.
   - 이번 사이클에서 다룰 핵심 문제 1개, 관측 가능한 완료 조건, 의도적 제외 범위(다음 사이클로 미룰 항목)를 명시한다.
   - 구현 세부(함수명·내부 구조)로 내려가지 않고 저·중해상도 목표 수준을 유지한다.

## Output (`memory_save` 기준선 계약)

HEAD가 아래 기준선 문서를 저장한다(1사이클에서 `P0`가 없으면 `P0` 먼저 저장).

- (최초 1회) `memory_save`:
  - `type: "baseline"`, `session: "<세션명>"`, `branch: "P0"`
  - `title`, `summary`, `content`(최초 목적·확정 제약·범위 외·최종 성공 기준)
- (매 사이클 `k`) `memory_save`:
  - `type: "baseline"`, `session: "<세션명>"`, `branch: "C{k}-IDEATION"` (예: `C1-IDEATION`, `C2-IDEATION`)
  - `derived_from: ["<SEED_ID>"]` (1사이클에서는 `["<P0_ID>"]`)
  - `title`, `summary`, `content`(단기 목표, 완료 신호, 범위 외 항목)

## Next Step (다음 단계)

- 저장된 `IDEATION_ID`를 들고 `cortex_prompt(kind: "skill", name: "plan-run/steps/02-execution-planning")`으로 이동한다.
