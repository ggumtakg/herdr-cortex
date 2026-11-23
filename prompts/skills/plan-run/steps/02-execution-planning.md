# 02. 실행 계획 수립 (Execution Planning)

## Trigger (진입 조건)

- `01-ideation`에서 `IDEATION_ID`가 저장된 직후, 또는 `03-minimum-plan-review` / `04-plan-acceptance`에서 `NEEDS_FIX` 판정을 받아 계획을 보완할 때 진입한다.

## Inputs (입력)

- `P0_ID`, `SEED_ID`, `IDEATION_ID` (`memory_read`로 원문 확인).
- 재검토 복귀 시: `03` 또는 `04` 리뷰어의 `Blockers`와 `Verified Facts`.
- 소프트웨어 변경 포함 시: `cortex_prompt(kind: "standard", name: "DEVELOPMENT_STANDARD")`.

## Execution (수행 절차)

1. 관련 기존 파일과 `memory_graph(target: "file:<경로>", direction: "in")`을 확인해 재사용할 기존 구현과 영향받는 계약을 파악한다.
2. `IDEATION`의 단기 목표를 워커가 즉시 실행 가능한 구체 규격(`PLAN`)으로 작성한다.
   - **필수 포함 항목**: 변경할 동작과 비범위, 재사용 대상 및 소유 파일 경계, 변경되는 데이터·계약·인터페이스, 대표 실행 경로(실제 입력 → 실제 출력)와 선택된 테스트 범위, 작업 분할(필요 시 병렬 가능 단위와 파일 소유권).
   - `DEVELOPMENT_STANDARD` 원칙에 따라 현재 요구사항에 직접 필요한 동작과 검증만 포함한다.
3. 보완 재진입이라면 기존 계획을 덮어쓰지 않고 새 `PLAN`을 작성하면서 `supersedes`로 직전 `PLAN_ID`를 대체 연결한다.

## Output (`memory_save` 기준선 계약)

HEAD가 `C{k}-PLAN` 기준선을 저장한다.

- `memory_save`:
  - `type: "baseline"`, `session: "<세션명>"`, `branch: "C{k}-PLAN"` (예: `C1-PLAN`, `C2-PLAN`)
  - `derived_from: ["<IDEATION_ID>"]`
  - `supersedes: "<이전_PLAN_ID>"` (보완 재작성 시에만 지정)
  - `files`: 수정 예정 프로젝트 상대 경로 목록
  - `title`, `summary`, `content`(실행 규격, 변경 경계, 대표 검증 명령)

## Next Step (다음 단계)

- 저장된 `PLAN_ID`를 들고 `cortex_prompt(kind: "skill", name: "plan-run/steps/03-minimum-plan-review")`로 이동한다.
