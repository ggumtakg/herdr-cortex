---
name: delegate
description: 경계가 확정된 단일 작업을 워커(researcher/coder/developer/reviewer)에게 1회성으로 위임하고 패키징된 결과를 회수·재통합하는 프로토콜.
---

# 경계 위임 프로토콜 (delegate)

고해상도 조사·구현·번역·검수를 HEAD 맥락에서 분리해 수행할 때 사용한다.

## 핵심 규칙: 한 번에 한 종류의 작업

- 하나의 위임에는 **단일 작업 유형**만 맡긴다. **조사와 구현을 한 워커에 함께 맡기지 않는다** — 원인과 고칠 위치를 모르면 먼저 `researcher`에게 조사를 맡겨 확정한 뒤, 별도 위임으로 `developer`나 `coder`에게 구현을 맡긴다.
- 작업이 여러 단계에 걸쳐 이어지면 위임을 나누거나 `plan-run`으로 전환한다.
- 워커와 서브에이전트는 기억 저장소에 대해 **읽기 전용**이며(`memory_save`/`memory_update` 호출 거부는 실수 방지 장치이지 보안 경계가 아니다), 정본 기록은 항상 결과 회수 후 HEAD가 수행한다.

## 1단계: 워커 역할 선택 및 명시 로드

작업 성격에 맞는 역할 코어를 `cortex_prompt`로 명시 로드해 위임 지시에 포함한다.

| 워커 역할 | `cortex_prompt` 호출 | 적합한 작업 |
| :--- | :--- | :--- |
| **`researcher`** | `kind: "agent", name: "researcher"` | 파일을 고치지 않고 읽기와 비파괴 명령으로 사실과 근거 위치(`파일:줄`, 실행한 명령과 출력)를 확인하는 조사 작업 |
| **`coder`** | `kind: "agent", name: "coder"` | 설계·인터페이스·동작 명세가 완전히 확정된 코드 번역(자율 설계 권한 없음) |
| **`developer`** | `kind: "agent", name: "developer"` + `kind: "standard", name: "DEVELOPMENT_STANDARD"` | 원인과 고칠 위치가 확정된 뒤 합의된 경계 안에서 구현하고 대표 경로 E2E 실행 증명을 마치는 개발 작업 |
| **`reviewer`** | `kind: "agent", name: "reviewer"` (+ 필요 시 `DEVELOPMENT_STANDARD`) | 수정 권한 없이 1차 근거로 결정·계획·결과를 비판적 검증 (`independent-review`와 결합) |

## 2단계: Entry Contract 5요소 작성

위임 프롬프트에는 반드시 아래 5요소를 명시한다. 하나라도 비어 있으면 위임 전 HEAD가 먼저 확정한다.

1. **소비자 (Consumer)**: 이 결과물을 누가, 다음 어떤 판단·단계에서 사용하는가.
2. **관측 산출물 (Observable Deliverable)**: 생성·수정할 파일(조사·검수면 수정 없음), 반환할 구조화 요약, 확인 가능한 출력 형식.
3. **권위 입력 (Authoritative Inputs)**: 기준선 문서 ID(`memory_read` 대상), 확정 결정, 직접 읽어야 할 파일 경로(프로젝트 상대 경로 권장). HEAD의 장황한 해석 대신 1차 근거를 제공한다.
4. **변경 경계 (Mutation Boundary)**: 수정 허용 파일/디렉터리, 건드리지 않는 소유 영역, 유지해야 할 외부 계약.
5. **대표 증명 (Representative Proof)**: 완료 전 실제 환경에서 실행해야 할 대표 명령과 통과 기준(실제 입력 → 실제 출력).

## 3단계: 실행 격리 및 `contract_conflict` Fail-Closed 처리

- 호스트 네이티브 서브에이전트, 다른 모델을 헤드리스로 띄우는 `cortex-worker` 명령(전체 사용법과 `--allow` 권한 지정은 `cortex_prompt(kind: "skill", name: "start-job")` 참조), 또는 유휴 Herdr 탭(`relay_tabs`로 조회한 뒤 `relay_send(to_terminal_id, message, context_docs, wake)`로 전달) 중 하나로 실행한다.
- 워커가 작업 중 **전달받은 원인의 불일치, 명세 모호성, 기존 계약 충돌, 소유 경계 밖 수정 필요, 물음 전제 불성립**을 확인하면 임의로 추측 수정하지 않고 즉시 **`contract_conflict`**(조사 워커는 전제·범위 한계 보고)로 중단해 관측 사실과 근거 위치를 HEAD에 반환한다.
- HEAD는 이를 받으면 원래 문제와 계약을 다시 맞추고, 필요 시 추가 조사나 사용자 확인을 거친 뒤 수정된 Entry Contract로 새 위임을 발행한다.

## 4단계: HEAD 결과 재통합

워커로부터 패키징된 결과(변경 파일 또는 조사 근거 위치, 정확한 검증 명령과 실제 출력, 상위 결정을 바꿀 제약·예외·불확실성)를 회수하면 HEAD가 아래를 수행한다.

1. 대표 실행 증명이 실제로 통과했는지 관측 출력으로 확인하고, 조사 결과는 근거 위치의 원본을 직접 읽어 대조한다.
2. 구현 산출물이나 중대한 계약·로직 변경은 `independent-review`를 새 컨텍스트로 실행해 편향 없이 검증한다.
3. 수용이 확정되면 `HEAD_CORE`의 기억 저장 규칙에 따라(결정을 합의했거나 커밋했거나 사용자 선호를 확인했을 때, 또는 L 작업 마무리 시 **그 턴의 최종 응답을 쓰기 전에**) HEAD가 `memory_save` 또는 `memory_update`로 작업 기록·결정·기준선 변경(변경 시 `supersedes`)을 정본에 반영한다.
   - `files` 파라미터에는 **프로젝트 상대 경로**를 전달한다.
   - 모든 프로젝트에 적용할 사용자 선호를 새로 확인했다면 `memory_save(type: "knowledge", scope: "global", category: "preferences", ...)`로 별도 보존한다.
