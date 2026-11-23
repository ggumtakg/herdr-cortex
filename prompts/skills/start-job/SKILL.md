---
name: start-job
description: 작업 진입 게이트. 문제·목표 합의, 기존 기억·코드 우선 재사용, 4가지 실행 형태(직접 실행·delegate·independent-review·plan-run) 라우팅을 결정한다.
---

# 작업 진입 게이트 (start-job)

새 요청이나 다음 단계로 진입할 때 바로 구현하지 않고 아래 3단계를 순서대로 거쳐 실행 경로를 확정한다.

## 1단계: 문제·목표·확정 조건 합의

- 요청을 사실 단위로 분해해 **현재 문제**, **달성할 목표**, **반드시 지켜야 할 제약(확정 조건)**, **범위 외 항목**을 명확히 한다.
- 전체 결과·방향을 바꾸거나 되돌리기 어려운 외부 영향이 있는 결정은 추천안과 함께 사용자 확인을 먼저 받는다.
- 요구사항이 아직 제품 기획 수준이라면 `cortex_prompt(kind: "skill", name: "product-planning")`으로 기획 3단계를 먼저 수행한다.

## 2단계: 기존 기억·코드 우선 탐색 및 재사용

실행 계획을 세우기 전 프로젝트 기억과 기존 코드를 먼저 조회해 중복 작업과 기존 결정 충돌을 방지한다.

1. `memory_overview`로 활성 세션·브랜치, 열린 `todo`, 최근 `decision`/`baseline`, 전역 선호도를 확인한다.
2. `memory_search`로 관련 주제·파일·세션의 기존 결정을 1단계 요약으로 탐색한다.
3. 핵심 문서만 `memory_read(id, include_neighbors: true)`로 전문을 읽고, 수정 대상 파일이 있다면 `memory_graph(target: "file:<프로젝트-상대경로>", direction: "in")`으로 영향받는 기존 결정·기준선을 확인한다.
4. 관련 소스 코드를 직접 읽어 재사용 가능한 기존 구현과 유지해야 할 계약을 확인한다.

## 3단계: 실행 형태 라우팅

작업의 복잡도, 맥락 오염 위험, 검증 필요성에 따라 아래 4가지 경로 중 하나를 명시적으로 선택한다.

| 실행 형태 | 선택 기준 | 실행 방법 및 로드할 자산 |
| :--- | :--- | :--- |
| **직접 실행** | 변경이 단순·즉시 완료 가능하고, 세부 결과를 HEAD가 곧바로 다음 판단에 써야 할 때 | HEAD가 직접 읽고 수정한 뒤 주 경로 실제 실행으로 증명한다. 결정 변경 시 `memory_save`(변경 시 `supersedes`)로 기록한다. |
| **기본 포크 / `delegate`** | 경계가 확정된 단일 작업(조사 1건, 명세 번역 1건, 경계 내 구현 1건)으로, 고해상도 세부를 HEAD 맥락에서 격리해야 할 때 | `cortex_prompt(kind: "skill", name: "delegate")`를 로드해 Entry Contract 5요소를 작성하고 `developer` 또는 `coder` 워커에 1회성 위임한다. |
| **`independent-review`** | HEAD 또는 워커가 산출물(계획·설계·코드)을 작성한 직후 편향 없는 독립 검수가 필요할 때 | `cortex_prompt(kind: "skill", name: "independent-review")`를 로드해 제작 맥락과 단절된 새 컨텍스트 `reviewer`에 1차 근거만 전달해 검수한다. |
| **`plan-run`** | 여러 사이클에 걸쳐 기획 → 최소성 검수 → 독립 수용 → 실행 → 결과 검수 → 진행 방향 점검을 자율적으로 반복해야 하는 중대형 작업일 때 | `cortex_prompt(kind: "skill", name: "plan-run")`을 로드해 `P0` 기준선을 `memory_save(type: "baseline", branch: "P0")`로 고정하고 8단계 파이프라인을 시작한다. |

## 진입 완료 체크

- 개발 작업으로 진입하면 `cortex_prompt(kind: "standard", name: "DEVELOPMENT_STANDARD")`를 참조 기준으로 삼는다.
- 합의된 목표·제약이 이후 여러 턴이나 워커에 걸쳐 유지되어야 하면 HEAD가 `memory_save`로 `decision` 또는 `baseline` 문서를 저장한다.
- `memory_save` / `memory_update`의 `files` 파라미터에는 **프로젝트 상대 경로**를 기록한다(프로젝트 루트 내부의 절대 경로는 저장 시 자동으로 상대 경로로 정규화되며, 프로젝트 외부 경로는 거부된다).
- 대화 중 확인된 전역 사용자 선호도는 `memory_save(type: "knowledge", scope: "global", category: "preferences", ...)`로 저장해 모든 프로젝트에서 재사용한다.
