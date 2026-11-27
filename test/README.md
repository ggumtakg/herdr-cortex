# `test/` — 자동화 테스트 스위트 (21개 파일 · 219개 테스트)

> [← 루트 README](../README.md)

이 폴더는 herdr-cortex 전체를 검증하는 테스트 21개 파일(`*.test.mjs`)과 테스트 지원 모듈 3개(`support/`)를 담습니다. 외부 테스트 프레임워크 없이 Node.js 내장 테스트 러너(`node:test`)와 `node:assert/strict`만 사용합니다. 테스트는 `os.tmpdir()` 아래에 만든 임시 폴더에서 실제 파일과 실제 SQLite로 동작하고, 사용자의 홈 디렉터리와 전역 저장소(기본 위치가 `<홈>/.herdr-cortex`인, 모든 프로젝트가 함께 쓰는 저장 폴더)는 환경 변수로 임시 폴더를 가리키게 한 뒤 실행합니다. 외부 프로그램(`hc`, `claude`, 임베딩 서비스, 확인 대화상자)은 대역(실물 대신 끼워 넣는 가짜 구현)으로 바꿔 실행하며, 어디까지가 실물이고 어디부터가 대역인지는 아래 [실물과 대역](#실물과-대역)에 적었습니다.

---

## 실행 방법

`package.json`의 `engines`는 Node.js `>=22.13.0`을 요구합니다. 벡터 관련 테스트가 `sqlite-vec` 패키지를 쓰므로 먼저 저장소 루트에서 `npm install`을 실행합니다.

```powershell
# 전체 스위트 (21개 파일, 219개 테스트)
npm test

# npm test 가 실제로 실행하는 명령 (package.json 의 scripts.test)
node --no-warnings --import ./test/support/isolate-home.mjs --test test/*.test.mjs

# 파일 하나만 실행: 같은 --import 를 붙이고 저장소 루트에서 실행한다
node --no-warnings --import ./test/support/isolate-home.mjs --test test/store-and-db.test.mjs
```

- `--import ./test/support/isolate-home.mjs`는 현재 폴더 기준 상대 경로이므로 저장소 루트에서 실행해야 합니다.
- `node`가 PATH에 없으면 `node` 자리에 Node 실행 파일의 전체 경로를 씁니다. PowerShell에서는 `& "<Node 설치 폴더>\node.exe" --no-warnings --import ...` 형태입니다. 테스트가 띄우는 자식 프로세스는 `process.execPath`(테스트를 실행 중인 Node)로 시작하므로 테스트 자체는 PATH의 `node`에 의존하지 않습니다.
- `--import`를 빼고 실행하면 아래의 홈 격리가 적용되지 않습니다. 이 경우 `home-isolation.test.mjs`의 첫 테스트가 `HERDR_CORTEX_TEST_GUARD_DIR is not set: run the suite through "npm test" ...` 메시지로 실패하고, 디렉터리를 직접 넘기지 않는 코드 경로가 실제 홈을 향할 수 있습니다. 파일 하나만 실행할 때도 반드시 `--import`를 붙입니다.

`package.json`에는 테스트 말고 세 개의 스크립트가 더 있습니다.

```powershell
npm test               # 자동 테스트 전체 (21개 파일, 219개)
npm run embed          # 임베딩을 기다리는 문서를 한꺼번에 처리
npm run mcp            # MCP 서버를 직접 실행
npm run trust -- list  # cortex-trust와 같은 명령 (프로필 없이)
```

각각의 옵션은 [`src/embeddings/README.md`](../src/embeddings/README.md#cli-npm-run-embed), [`src/mcp/README.md`](../src/mcp/README.md#직접-실행-옵션과-환경변수), [`src/core/README.md`](../src/core/README.md#명령줄-trust-climjs)에 있습니다.

---

## 실제 홈 격리

### `support/isolate-home.mjs`가 하는 일

`npm test`는 이 모듈을 `--import`로 넘깁니다. 모듈은 러너 프로세스에서 한 번, 그리고 테스트 파일마다 따로 뜨는 프로세스에서 각각 한 번씩 실행됩니다(러너가 `--import` 플래그를 각 테스트 파일 프로세스에 그대로 넘깁니다).

1. 가드 변수 `HERDR_CORTEX_TEST_GUARD_DIR`(모듈이 `TEST_GUARD_VARIABLE`로 내보내는 이름)가 비어 있으면 `os.tmpdir()` 아래에 `herdr-cortex-test-home-` 접두어의 임시 폴더를 만들고 그 경로를 가드 변수에 넣습니다. 폴더를 만든 프로세스는 종료할 때 그 폴더를 통째로 지웁니다(`maxRetries: 3`, `retryDelay: 50`ms, 실패는 무시).
2. 가드 변수가 이미 있으면(테스트 파일 프로세스가 러너에게서 물려받은 경우) 그 폴더를 다시 쓰고 지우지 않습니다. 실행 전에 이 변수를 직접 설정해 두면 그 폴더가 쓰이고 실행 뒤에도 남습니다.
3. 어느 경우든 다음 환경 변수를 설정합니다.

| 환경 변수 | 설정되는 값 | 영향받는 것 |
| :--- | :--- | :--- |
| `USERPROFILE` | 가드 폴더 | Windows에서 `os.homedir()`가 돌려주는 홈 |
| `HOME` | 가드 폴더 | POSIX에서 `os.homedir()`가 돌려주는 홈 |
| `HERDR_CORTEX_TEST_HOME` | 가드 폴더 | `resolveHomeDir()`가 고르는 홈(Claude Code·Antigravity 설정 파일 위치의 기준) |
| `HERDR_CORTEX_HOME` | `<가드 폴더>/.herdr-cortex` | `resolveGlobalDir()`가 고르는 전역 저장소 |
| `HERDR_REVIVE_TEST_HOME` | 삭제 | `HERDR_CORTEX_TEST_HOME`과 같은 뜻의 레거시 이름이 바깥 환경에서 흘러들지 않게 함 |

`TEMP`/`TMP`는 바꾸지 않으므로 임시 폴더 자체는 실제 임시 폴더입니다.

### 보장 범위

- **보장되는 것**: 테스트 프로세스와, 그 환경을 물려받은 자식 프로세스 안에서 `os.homedir()` 또는 `src/core/config.mjs`의 `resolveHomeDir()`·`resolveGlobalDir()`·`getGlobalDir()`로 위치를 정하는 코드는, 테스트가 디렉터리를 넘기는 것을 잊어도 가드 폴더 안을 가리킵니다. 테스트가 `globalDir`·`homeDir` 같은 인자를 직접 넘기면 그 인자가 환경 변수보다 우선합니다.
- **수단**: 환경 변수뿐입니다. 파일 시스템 접근을 막는 샌드박스가 아닙니다. 절대 경로를 직접 쓰는 코드, 환경 변수를 거치지 않고 운영체제 API로 사용자 폴더를 얻는 코드, 실제 홈을 가리키는 환경을 새로 만들어 자식 프로세스에 넘기는 코드가 있다면 이 장치로는 막을 수 없습니다.
- **증명하는 테스트**: `home-isolation.test.mjs`의 첫 테스트가 가드 변수가 설정되어 있고 임시 폴더 안의 디렉터리인지, `os.homedir()`·`resolveHomeDir()`·`resolveEffectiveHome()`이 가드 폴더인지, `getGlobalDir()`·`resolveCortexGlobalDir()`이 `<가드 폴더>/.herdr-cortex`인지, 승인 목록 경로가 `<전역 저장소>/state/trusted-projects.json`인지, 레거시 세션 폴더가 가드 폴더 안인지를 단언합니다. 이어서 환경을 물려받은 자식 프로세스가 같은 값을 얻는지, `HERDR_CORTEX_TEST_HOME`만 따로 받고 `HERDR_CORTEX_HOME`이 없는 자식 프로세스가 전역 저장소를 그 테스트 홈 아래에 두는지를 확인합니다. 이 단언은 `home-isolation.test.mjs`의 프로세스와 그 자식에 대한 것이며, 다른 테스트 파일의 프로세스는 같은 `--import`를 받지만 파일마다 따로 단언하지는 않습니다.

### 파일별 추가 안전장치

- `cortex-status.test.mjs`, `installer.test.mjs`, `relay-inbox.test.mjs`는 파일을 불러올 때 자기만의 임시 폴더를 만들어 `HERDR_CORTEX_TEST_HOME`을 그쪽으로 다시 지정하고 프로세스 종료 시 지웁니다(앞의 두 파일은 `HERDR_CORTEX_HOME`도 그 폴더 아래로 지정하고, `relay-inbox.test.mjs`는 `HERDR_CORTEX_HOME`을 지웁니다).
- `cortex-status.test.mjs`, `installer.test.mjs`, `powershell-scripts.test.mjs`, `powershell-store-location.test.mjs`는 자식 프로세스의 `USERPROFILE`을 "실제 홈 대역" 폴더로 지정하고, 그 폴더에 PowerShell 자체 캐시(`AppData`) 말고는 아무것도 생기지 않았는지 확인합니다. 이 확인도 `USERPROFILE` 환경 변수를 따르는 코드에 대해서만 의미가 있습니다.
- `config-and-embeddings.test.mjs`는 `globalThis.fetch`를 바꿔 `127.0.0.1`·`localhost` 이외의 호스트로 가는 요청을 거부하고 기록하며, 여러 테스트가 그 기록이 비어 있는지 단언합니다. `cortex-status.test.mjs`의 첫 테스트는 `fetch`가 한 번도 호출되지 않았는지 단언합니다.

### 지원 모듈

| 파일 | 역할 | 내보내는 것 |
| :--- | :--- | :--- |
| `support/isolate-home.mjs` | 위의 홈 격리. `--import`로 불러오며, `home-isolation.test.mjs`만 변수 이름을 가져다 씁니다. | `TEST_GUARD_VARIABLE` |
| `support/approve.mjs` | 테스트 준비 단계에서 프로젝트 폴더를 승인합니다. 승인이란 사용자가 `cortex-trust approve`를 실행하고 확인 대화상자에서 Yes를 눌러 그 폴더의 `.memory/`를 읽어도 된다고 허락하는 일입니다. `approveAsUser`는 명령줄도 대화상자도 거치지 않고 `approveProject`(승인 목록에 추가)와 `acknowledgeApproval`(사용자가 확인한 목록에 추가)을 차례로 호출하므로, 훅이 "대화상자 없이 승인 목록이 바뀌었다"는 경고를 내지 않는 상태가 됩니다. 그 경고 자체를 다루는 테스트는 `approveProject`만 직접 호출합니다. 14개 테스트 파일이 사용합니다. | `approveAsUser(projectDir, { globalDir, now })` |
| `support/no-dialog-env.mjs` | 자식 프로세스가 `cortex-trust`의 실제 확인 대화상자를 띄울 수 없는 환경을 만듭니다. `makeNoDialogEnv`는 `SystemRoot`·`windir`를(대소문자가 다른 표기까지 모두 지운 뒤) 빈 폴더로 지정해 Windows PowerShell을 찾지 못하게 하고, `assertNoDialogEnv`는 그 환경의 자식 프로세스에서 `resolveWindowsPowerShell()`이 돌려주는 경로가 존재하지 않는 파일임을 먼저 확인합니다. `trust-confirm.test.mjs`가 사용합니다. | `makeNoDialogEnv(baseEnv, emptyDir)`, `assertNoDialogEnv(env)` |

---

## 테스트 스위트 구성

테스트 수는 각 파일에서 줄 맨 앞의 `test(` 호출을 센 값입니다. `describe`/`it`, `test.skip`, `test.todo`, `test.only`, 중첩 하위 테스트(`t.test`)는 어느 파일에도 없습니다. "조건부" 열은 `{ skip: ... }` 옵션이 붙어 환경에 따라 건너뛰는 테스트 수입니다(조건은 [실행 조건과 건너뛰기](#실행-조건과-건너뛰기) 참고).

| 파일 | 테스트 수 | 조건부 | 검증 범위 |
| :--- | :---: | :---: | :--- |
| **`background-indexing.test.mjs`** | 6 | 0 | **도구 호출과 색인**: 크게 바뀐 문서는 뒤로 미루고 호출은 색인 중 안내와 함께 바로 응답하며 따라잡기 뒤에는 검색됨, 파일 크기로 추정하는 시간 예산과 기본 한도, `project_dir`로 지정한 다른 프로젝트에도 같은 한도와 별도 저장소로 따라잡기.<br>**임베딩 큐**: 프로바이더가 설정된 경우 한 번에 파일 하나씩 색인을 따라잡아 시작 직후의 도구 호출이 기다리지 않음.<br>**공유 동기화**: 진행 중인 실행에 합류, 파일은 한 번씩만 읽음, 어느 호출자든 취소 가능, 실행 중이거나 직후에 들어온 따라잡기 요청도 누락 없이 처리. |
| **`config-and-embeddings.test.mjs`** | 23 | 0 | **기본값과 설정 형태(9)**: 임베딩 기본값은 `none`이라 환경에 키가 있어도 아무것도 보내지 않고 `auto`는 명시해야 함, 프로바이더 이름 오타는 설정 오류로 상태 함수와 `npm run embed`가 보고, 프로바이더는 자기 설정 묶음만 읽음, 구 형식의 평면 키는 무시하고 한 번 경고(전역·프로젝트별·`.memory/config.json` 상황별 안내 포함), 프로젝트별 임베딩 설정은 전역 설정의 `projects` 맵(실제 경로 일치)에서만 오고 프로젝트 파일로는 설정 불가, `describeEmbeddingStatus`(프로바이더·목적지 호스트·키 출처 이름·차단기 상태·문제점을 네트워크 없이 키 값 없이 설명), 설치기가 쓰는 기본 설정과 embed CLI 플래그, embed CLI의 인자 오류(`--scope`의 모르는 값, `--max-docs`의 양의 정수가 아닌 값, 값 없는 스위치는 아무것도 읽거나 바꾸지 않고 `invalid_arguments` 요약과 종료 코드 1).<br>**장애 처리(8)**: 질의 임베딩의 자체 타임아웃·1회 시도·키워드 결과로 응답(`vectorSkipped`), 서비스 쪽 실패 한 번으로 질의 임베딩과 문서 큐를 함께 쉬게 하는 차단기(인증 오류는 별도 정지), 장애는 `embed_attempts`에 세지 않고 문서 고유 실패만 3회 상한, 휴지 뒤 재시도와 복구 시 자동 재개, MCP 서버 시작 시 대기 문서 임베딩, 포기한 문서의 계층별 집계와 `--retry-failed`, 같은 문서에서 서비스 쪽 실패 10회면 포기, 긴 장애가 한 문서에 몰리지 않도록 순환.<br>**벡터 정리와 대상(5)**: 벡터 확장 없는 연결이 남긴 고아 벡터 삭제(2), `project_dir`로 저장·갱신한 다른 프로젝트나 전역 계층의 임베딩 예약과 DB 핸들 닫힘(2), 전역 계층은 전역 설정만 따르고 프로젝트별 설정은 그 프로젝트 계층에만 적용.<br>**MCP 서버(1)**: instructions의 `supersedes` 안내, 객체가 아닌 도구 인자에 `-32602`. |
| **`core-robustness.test.mjs`** | 16 | 0 | **진입점**: 스크립트 5개의 메인 모듈 판정이 정션·심볼릭 링크 경로로 실행해도 동작.<br>**frontmatter**: 링크·제목 스캐너가 정규식과 같은 결과를 내고 300KB 대괄호 입력도 1초 안에 처리.<br>**시각**: 밀리초 정밀도, 혼합 형식 비교, 생성 순서대로의 `session_next`.<br>**MCP·도구**: JSON-RPC 배치 요청에 `-32600` 오류 한 건(stdio 왕복), 모든 도구가 알 수 없는 인자를 허용 목록과 함께 거부(`_caller_agent_id`는 허용), `memory_update`의 `supersedes` 전이와 경고, `memory_overview`의 `budget`을 256~50,000 범위로 맞추고 숫자가 아닌 값은 생략으로 처리(스키마와 README가 같은 상수를 씀), `package.json`·`package-lock.json`·`SERVER_INFO`·MCP README의 버전 일치.<br>**DB·동시성**: 중복 id 경고는 (id, 경로)당 한 번이고 `getDuplicateDocIds`가 현재 중복을 나열, 여러 프로세스의 동시 `updateDoc`에서 갱신 유실 없음.<br>**문서 갱신과 인코딩**: 손으로 쓴 문서를 `memory_update`로 고칠 때 파서가 모르는 frontmatter 줄 보존, 인코딩 감지(BOM·UTF-8·CP949, 그 외는 안전하지 않음으로 보고), CP949·UTF-16 문서는 UTF-8로 변환하고 해석할 수 없는 파일은 거부, 수평선으로 시작하는 문서, 도구가 쓴 문서는 요청한 필드만 바이트 단위로 변경. |
| **`cortex-status.test.mjs`** | 5 | 0 | **`scripts/cortex-status.mjs`**: 새 설치에서 모든 점검이 정상이고 네트워크 요청이 없으며 키 값이 출력에 없음, Node 경로 소실·훅과 MCP 등록의 누락이나 손상·미승인 또는 제외 폴더·설정 문제를 각각 조치 방법과 함께 표시, Antigravity가 있는지를 설치기와 같은 근거(PATH의 `agy` 또는 `~/.gemini`)로 판정하고 찾은 근거를 줄에 표시, 승인 상태·계층별 임베딩 상태와 포기한 문서·색인에서 빠진 문서·중복 id·이 탭의 대기 및 보관 릴레이 메시지 표시, 명령줄(`--cwd`, `--json`) 출력. |
| **`hc-status.test.mjs`** | 5 | 0 | **`hc` 상태 어휘**: `idle`·`working`·`done`·`blocked`·`error`만 인정하고 그 밖의 단어는 unknown, 터미널 상태는 live 또는 finished.<br>**`hc send` 실패 분류**: 대상의 상태를 말하는 종류(막힘, 상태 변경, 종료, 없음)와 `hc` 자체의 실패 구분.<br>**릴레이 도구**: `done`인 탭은 `--if` 없이 깨우고 `idle`은 `--if idle` 유지, 거부는 종류별로 보고, `relay_tabs`의 `blockedKind`.<br>**보관 시간 문구(2)**: 릴레이 도구 설명과 서버 instructions의 보관 시간이 `INBOX_DELIVERED_RETENTION_MS`에서 만들어지고 두 소스 파일(`src/relay/tools.mjs`, `src/mcp/server.mjs`)의 주석을 뺀 코드에 숫자 `24`가 없음. |
| **`home-isolation.test.mjs`** | 4 | 0 | **홈 격리 증명**(위 절 참고).<br>**전역 저장소 위치의 우선순위**: 명시 인자, `HERDR_CORTEX_HOME`, `<HERDR_CORTEX_TEST_HOME>/.herdr-cortex`, `<사용자 홈>/.herdr-cortex` 순서이고 공백 값은 미설정으로 취급, 설치기도 같은 순서를 따름.<br>**`cortex-trust` 기본 폴더**: `INIT_CWD`는 이 패키지의 `trust` npm 스크립트로 실행할 때만 사용. |
| **`hook-hardening.test.mjs`** | 13 | 0 | **색인 미루기(4)**: 훅은 시간 안에 되는 만큼 색인하고 큰 문서는 안내와 함께 미루며 MCP 서버가 따라잡음, 파일 크기 기반 시간 예산·기본값·안내 한도, 미룬 파일을 삭제된 파일로 취급하지 않음, 파일 사이에서 죽은 동기화는 끝낸 파일을 유지하고 다음 동기화가 나머지를 완료, 백그라운드 동기화의 양보와 색인할 수 없는 파일의 오류 기록.<br>**`/clear` 복원(2)**: SessionEnd 훅이 기록한 세션에서만 대화를 복원하고 추측한 기록은 쓰지 않음, 탭 기록으로 이전 세션을 정확히 식별, 설치기가 SessionEnd를 등록.<br>**최근 대화(3)**: Claude Code 기록의 종류별로 누가 입력했는지 분류, 알림·보고·리마인더가 실제 프롬프트를 5턴 창 밖으로 밀어내지 않음, 거대한 마지막 레코드를 만나면 읽는 범위를 넓히고 상한 도달을 보고.<br>**PreCompact(1)**: 훅 프로세스가 지시문을 일반 텍스트로 출력하고 서브에이전트와 제외 프로젝트에는 아무것도 출력하지 않음.<br>**주입 상한(1)**: `hookBudget`을 1,000,000으로 설정해도 Antigravity 훅까지 9,000자로 제한.<br>**PreToolUse(2)**: 승인 파일을 이름으로 가리키는 명령과 승인 파일·전역 state 폴더에 대한 쓰기는 사용자에게 묻고 서브에이전트는 거부, 승인 CLI 실행은 그 CLI의 확인 대화상자에 맡기되 서브에이전트는 거부, 읽기 전용 명령과 닮은꼴 문자열은 통과. |
| **`hooks-and-budget.test.mjs`** | 13 | 0 | **세션 추적**: 서브에이전트가 부모 세션 기록을 덮어쓰지 않음, 이전 세션 id와 이력 보존, 레거시 저장소(`.herdr-revive`) 읽기.<br>**최근 대화 추출(3)**: Claude JSONL의 필터링·경계·대기 명령과 사용자 응답 보존·예산 상한, Antigravity JSONL의 최신 DONE CHECKPOINT와 마지막 5턴, 2MB를 넘는 JSONL의 뒷부분 읽기와 잡음 패턴 처리.<br>**Claude 훅**: SessionStart(`core`·`context` 분리와 `resume`·`fork` 중복 생략, `source`가 `compact`인 시작, 9,000자 상한, 서브에이전트 생략), PreCompact, UserPromptSubmit, PreToolUse의 호출자 위장 방지.<br>**Antigravity 훅(2)**: SessionStart의 서브에이전트 생략, PreInvocation의 `/compact` 입력 시 한 줄 안내·CHECKPOINT 1회 복원·받은편지함 전달, `rootConversationId` 없는 서브에이전트 판별과 역할을 알 수 없을 때의 보류, 초기화하지 않은 프로젝트에 `.memory/`를 만들지 않음.<br>**설치기**: 설치와 제거를 반복해도 같은 결과이고 사용자 설정을 보존하며 레거시 revive 훅을 제거하고 관리 대상 스킬만 설치·삭제.<br>**프로젝트 범위**: `excludedProjects`와 opt-in 모드가 주입을 막되 세션 추적은 유지.<br>**기준선과 기억 0건 안내**: P0만 있는 기준선이 두 훅에 모두 표시되고 활성 문서 0건인 승인 프로젝트에서 `EMPTY_MEMORY_NOTICE` 주입. |
| **`injection-guards.test.mjs`** | 10 | 0 | **주입 내용 정리(4)**: `sanitizeInline`의 한 줄화(제어 문자와 줄 머리 제목 표시 제거), 악의적 frontmatter가 어떤 예산에서도 제목이나 새 줄을 만들지 못하고 안내문이 항상 붙음, 훅과 `memory_overview`가 그런 문서를 안내문 아래 한 줄 레코드로 주입, 릴레이 받은편지함 블록(제목 아래 안내문, 정리된 메타데이터, 인용된 본문, 안내문 없이는 아무것도 내보내지 않음).<br>**`hc` 실행 파일(1)**: PATH에서만 찾고 절대 경로로 그 파일이 있는 폴더에서 시작하며 현재 폴더의 것은 실행하지 않음.<br>**PreToolUse(5)**: 두 서버 이름(`herdr-cortex`, 레거시 `cortex`)의 도구를 한 함수로 인식, 다른 프로젝트로의 `memory_save`·`memory_update`는 사용자에게 묻고 같은 프로젝트와 읽기는 묻지 않음, 서브에이전트의 `.memory/` 파일 편집과 셸 명령 언급 차단, 훅 프로세스는 관여하지 않는 호출에 아무것도 출력하지 않음, 설치기가 PreToolUse 훅을 한 번만 등록하고 매처가 이 서버의 도구와 파일·셸 도구를 포함. |
| **`installer.test.mjs`** | 13 | 0 | **Node 경로(2)**: Claude Code 훅은 Node 절대 경로를 쓰는 exec 형식이고 MCP 항목과 설치 기록도 그 경로를 담음, Antigravity 훅 명령은 공백과 비ASCII 문자가 있는 경로에서도 `cmd.exe`·PowerShell·bash가 모두 실행하는 한 줄.<br>**소유 식별(1)**: `--id herdr-cortex`가 붙은 훅만 자기 것으로 보고 사용자의 훅과 그 그룹은 설치·제거 뒤에도 남음.<br>**이름과 자리표시자(3)**: 서버·등록 키·PreToolUse 매처는 `herdr-cortex`이고 훅은 레거시 접두어도 인식하며 `prompts/`는 어느 접두어도 쓰지 않음, 스킬 복사 시 `{{HERDR_CORTEX_ROOT}}` 자리표시자 치환, 레거시 `cortex` 항목은 자기 것일 때만 제거하고 남의 `herdr-cortex` 항목이 있으면 설치를 멈추며 제거는 자기 항목만 지움.<br>**`claude` CLI 등록(1)**: `claude mcp add`/`remove`(user 범위)로 등록·해제하고 파일 직접 수정은 대체 수단.<br>**안전한 쓰기(3)**: 모든 파일을 검사한 뒤에 쓰고 하나라도 잘못되면 아무것도 바꾸지 않고 그 파일을 알림, 기존 파일을 바꿀 때마다 날짜가 붙은 백업을 만들고 고정 이름의 레거시 백업도 인식하며 백업 나열·삭제 가능, Antigravity 설정은 Antigravity가 있을 때만(`agy`가 PATH에 있거나 `~/.gemini`가 있을 때) 건드림.<br>**기본 설정과 옛 키 이관(2)**: 이전 버전의 기본값 그대로인 `config.json`은 백업 뒤 교체하고 편집된 파일의 옛 평면 임베딩 키는 특정 프로바이더일 때만 새 묶음으로 이관·정리.<br>**상태 점검(1)**: 이벤트별 훅 등록 확인과 MCP 등록 확인이 무엇이 틀렸는지 알림. |
| **`orchestration-prompts.test.mjs`** | 6 | 0 | **`cortex_prompt`**: 저장소의 실제 `prompts/`에서 HEAD_CORE, DEVELOPMENT_STANDARD, 스킬 5개, plan-run 단계 8개, 에이전트 4개를 불러오고 자산 목록을 조회하며 경로 탈출을 막음, `HEAD_CORE.md`·`start-job`의 글자 수 상한(4,500자 이하)과 S/L 판정·조사/구현 분리 규약 확인.<br>**계보**: `P0 → PLAN → PN → RESULT`를 `memory_graph`로 양방향 추적, 다중 사이클의 5홉 계보와 DONE 기준선 보관.<br>**프롬프트 규약**: 검수 프롬프트들의 5구획(Verified Facts, Open Facts, Blockers, Minor Notes, Verdict) 일치, 04단계가 03단계와 분리됨, 다중 사이클 `C{k}-*` 규약.<br>**저장소 청정도 검사(1)**: 범위는 [아래 절](#저장소-청정도-검사의-범위) 참고. |
| **`powershell-scripts.test.mjs`** | 7 | 7 | **실행 정책 변경 판정(1)**: 정책을 저장한 뒤 "더 우선하는 범위가 덮어쓴다"는 보안 오류를 던지는 경우를 성공으로, 저장하지 못한 경우를 실패로 판정. **프로필 블록(2)**: 파일의 원래 인코딩으로 쓰고 날짜가 붙은 백업을 만들며 블록 밖의 바이트는 그대로이고 제거하면 원래 파일로 돌아감, 다른 내용 사이에서 제자리 교체, 전신 도구(`herdr-revive`)의 블록 제거, 파일 인코딩으로 표현할 수 없는 블록이나 깨진 표식은 그 프로필을 건드리지 않고 중단.<br>**탭 복구(2)**: `revive-agents`가 저장된 세션 id로 재개하고(저장된 폴더가 다르면 먼저 이동) 사라진 폴더는 건너뛰며 폴더를 공유하는 탭에서는 `-c`로 추측하지 않음, `auto-revive`가 빈 셸로 시작한 탭에 같은 계획을 적용하고 `hc`가 탭 목록을 주지 못하면 추측하지 않음.<br>**셸 명령(1)**: `cortex-trust`와 `cortex-status`가 설치 때 기록한 Node 경로로 실행되고 그 경로가 사라지면 알림.<br>**설치·제거 전 과정(1)**: `install.ps1`과 `uninstall.ps1`을 테스트 홈에서 실행(`-NodePath`, 검사 후 쓰기, 프로필 인코딩 유지, 실행 정책은 동의가 있을 때만 바꾸고 되돌림, 남는 것 안내, 요청 시 백업과 데이터 삭제). |
| **`powershell-store-location.test.mjs`** | 3 | 3 | **`scripts/store-location.ps1`**: PowerShell 스크립트가 Node 쪽과 같은 순서로 홈과 전역 저장소를 정함.<br>**설치 스크립트**: `install.ps1`·`uninstall.ps1`과 그들이 시작하는 Node 설치기가 `HERDR_CORTEX_HOME`이 가리키는 곳에 전역 저장소를 둠, `install.ps1`은 치명적 문제에서 스스로 종료 코드 1로 끝남. |
| **`project-trust.test.mjs`** | 14 | 0 | **승인 목록(2)**: 전역 저장소의 state 파일에 있고 실제 경로 기준으로 폴더 하나에만 적용, `cortex-trust`의 approve·status·list·revoke와 기본 폴더(현재 폴더).<br>**저장소와 설정(1)**: 미승인 폴더의 `.memory/`는 저장소가 열지 않고 설정 로더가 읽지 않음.<br>**훅(4)**: Claude 훅은 미승인 `.memory/`를 주입하지도 건드리지도 않고 승인 방법을 안내(홈·루트 폴더 제외 및 예산 보호 포함), 프로젝트 안 레거시 받은편지함은 승인되고 활성인 프로젝트에서만 읽어 전역으로 옮기며 전역 받은편지함은 승인과 무관하게 전달, Antigravity 훅도 미승인 `.memory/`를 건너뛰고 상태를 전역 저장소에 둠.<br>**MCP 도구(2)**: 미승인 기본 프로젝트에 대한 프로젝트 계층 호출은 `PROJECT_NOT_APPROVED`로 실패하고 읽기는 전역 결과로 대체, `project_dir`는 승인된 폴더만 가리킬 수 있음.<br>**임베딩(1)**: `npm run embed`와 서버 큐가 미승인 프로젝트를 건너뜀.<br>**제외 정책(1)**: 정션이나 다른 표기의 경로로 `excludedProjects`·`enabledProjects`를 우회할 수 없음.<br>**제외된 프로젝트의 MCP 서버(2)**: 시작 안내문이 막히는 것과 되는 것을 적고 도구가 그대로 동작(전역 조회·저장·갱신과 `cortex_prompt`는 되고, 프로젝트 계층 호출과 릴레이 도구는 `PROJECT_EXCLUDED`, `.memory/`는 만들지 않음), `memory_search`·`memory_graph`가 프로젝트 계층을 빼고 답한 결과에는 `projectExcluded`가 붙고 전역만 요청한 호출에는 붙지 않음.<br>**`.memory/.gitignore`(1)**: 첫 쓰기 때 만들고 덮어쓰지 않으며 읽기로는 만들지 않음. |
| **`relay-inbox.test.mjs`** | 16 | 0 | **받은편지함 저장(2)**: 위치는 `<전역 저장소>/state/inbox/<terminalId>/`, terminalId 검증, 선입선출, id로 ack, 읽을 수 없는 파일의 `.broken/` 격리, 승인된 프로젝트의 `.memory/state/inbox/`에 남아 있던 메시지를 전역 받은편지함으로 한 번 옮김.<br>**잠금과 동시성(2)**: `.lock` 파일(배타 생성, pid와 시각)로 소비자는 한 번에 하나이고 진 쪽은 기다리지도 잃지도 않으며 죽거나 멈춘 소비자의 잠금은 교체, 프로세스 6개가 한 받은편지함의 메시지 240개를 동시에 비워도 각각 정확히 한 번 전달.<br>**전달 한도(2)**: 남은 자리가 없으면 다음 프롬프트로 미루고 완전히 주입된 메시지만 ack, 주입 예산보다 긴 메시지는 한 번 알리고 뒤 메시지를 막지 않으며 `relay_inbox`가 ack할 때까지 보관.<br>**보관(1)**: 훅이 주입한 메시지는 24시간 보관되고 다시 주입되지 않으며 조회·ack할 수 있고 이후의 비우기에서 정리.<br>**`hc` 출력 해석(2)**: 권한 대화상자에서 기다리는 탭을 blocked로 읽고 거부된 `hc send`를 `target_blocked`로 보고, `hc ls`의 문자열 상태와 `hc get`의 객체 상태, unknown은 busy가 아님, 한 줄 트리거, `hc`가 없을 때의 처리.<br>**릴레이 도구(4)**: 도구 10개 노출과 `relay_tabs`·`relay_send`(wake `auto`/`always`/`never`)·`relay_inbox`, 프로젝트를 넘는 `relay_send`는 대상 터미널의 전역 받은편지함에만 씀, wake 정책(auto는 idle인 에이전트만, 읽을 수 없는 상태는 `target_status_unknown`, always도 빈 셸·live가 아닌 탭·error 상태는 깨우지 않음), 다른 PC의 탭(`pc2/t3`)은 `REMOTE_TERMINAL_UNSUPPORTED`.<br>**경로와 정책(3)**: 정션으로 닿은 폴더는 같은 프로젝트, 제외된 프로젝트에서는 세 도구가 `PROJECT_EXCLUDED`를 돌려주고 훅이 전달하지 않으며 메시지는 전역 받은편지함에서 대기, MCP 서버의 제외 정책 적용·`derived_from` 배열 스키마·`depth` 최대 10·`project_dir`·`-32603` 오류 처리. |
| **`search-rrf.test.mjs`** | 9 | 0 | **키워드 검색**: 한국어 1~2자와 3자 이상 질의, 문장부호와 조사 처리, SQL 단계의 필터 적용.<br>**벡터 검색**: 모의 프로바이더로 벡터 색인, RRF 융합, 오프라인일 때 키워드로 대체, 모델 변경 시 재구축, 벡터가 없으면 질의 임베딩을 호출하지 않음, 거리 컷오프, 계층 간 RRF.<br>**벡터 테이블 유지**: 벡터가 채워진 뒤의 문서 갱신·삭제, `disableVec: true`로 다시 열기, 메타데이터만 바꿀 때 벡터와 `embed_status=ready` 보존.<br>**임베딩 신뢰성**: 3회 상한, 401 차단, 오래된 해시 보호, 큐 비우기, Gemini 헤더·배치·재시도, Ollama nomic 접두어, `buildDocChunks`.<br>**MCP**: 서브에이전트 쓰기 거부(`SUBAGENT_WRITE_DENIED`), `cortex_prompt`, `extraTools` 확장, stdio 자식 프로세스 왕복.<br>**embed CLI**: 제외된 프로젝트 건너뛰기, 남은 문서가 0이 될 때까지 배치 반복, 오류 시 `exitCode=1`. |
| **`store-and-db.test.mjs`** | 16 | 0 | **설정과 검증**: ID 검증, 경로 탈출 방지, 설정 병합, 프로젝트 `.memory/config.json`의 허용 목록(임베딩 주소·키·제외 정책을 프로젝트 파일로 바꿀 수 없음)과 깨진 전역 설정 경고, `files` 경로 탈출 입력 거부.<br>**frontmatter**: 왕복 파싱, 참조 추출, 섹션 단위 청크, 들여쓴 `---`가 있는 여러 줄 값.<br>**저장소**: CRUD, `supersedes` 전이, `updateDoc`, 읽기는 `.memory/`를 만들지 않음, 제외된 프로젝트의 프로젝트 쓰기 거부, 세션을 지울 때 `session_next` 간선 정리.<br>**DB**: SQLite 파일을 지운 뒤 마크다운에서 문서와 관계를 다시 만듦(이 테스트는 벡터를 다루지 않음), 손상된 SQLite 자동 복구, WAL 모드의 동시 읽기·쓰기, 중복 id와 잘못된 수동 id, DB 파일이 잠겨 있을 때 `unlinkDbFiles`가 `-wal`·`-shm`을 지우지 않음(Windows에서만 단언), 768차원 50개 문서의 DB 파일이 1MB 미만.<br>**그래프와 개요**: 1~2홉 탐색과 `file:<경로>` 조회, 순환이 있어도 안전한 6홉 탐색과 계층 간 병합, 예산에 맞춰 단계적으로 줄이는 개요(`FIT_STEPS`), P0 기준선 보호. |
| **`trust-confirm.test.mjs`** | 11 | 1 | **확인 절차(3)**: 대화상자의 Yes만 확인으로 인정하고 대화상자가 없으면 터미널에서 `yes` 전체를 입력해야 하며 둘 다 없으면 아무에게도 묻지 않음, 대화상자 스크립트(제목 `herdr-cortex`, 기본 버튼 No, 맨 위 표시, 경로는 스크립트 문자열이 아니라 stdin 데이터로 전달), 실제 Windows PowerShell을 거친 왕복(조건부).<br>**`cortex-trust approve`(2)**: 실제 폴더 경로만 묻고 확인된 yes에만 승인하며 질문을 건너뛰는 스위치가 없음, 자식 프로세스에서 status·list·revoke는 동작하고 approve·acknowledge는 대화상자도 터미널도 없으면 종료 코드 2로 거부.<br>**대화상자 없이 바뀐 승인(4)**: 확인 목록은 사람이 본 폴더만 기록하고 직접 편집은 acknowledge나 되돌리기 전까지 계속 보고, Claude 훅이 다음 프롬프트에서 세션과 변경마다 한 번 사용자(`systemMessage`)와 모델 양쪽에 알림, PreToolUse가 확인 목록 파일도 승인 파일처럼 보호, Antigravity 훅과 `cortex-status`도 같은 내용을 보고.<br>**사용자용 알림(1)**: SessionStart가 미승인·미색인·대화 미복원을 `systemMessage` 줄로도 내보내고 일상 출력은 내보내지 않음.<br>**`/clear`(1)**: SessionStart가 아직 없는 clear 기록을 100ms 간격으로 최대 2초 기다림. |
| **`worker-role.test.mjs`** | 4 | 0 | **`HERDR_CORTEX_ROLE=worker`**: 공백·대소문자 무시 판정, Claude·Antigravity 훅에서 부모 탭 세션·받은편지함·`/clear` 기록·1회 미승인 안내 보존 및 `HEAD_CORE`·최근 대화 제외, MCP 서버의 쓰기 도구 `SUBAGENT_WRITE_DENIED` 차단과 읽기 도구 허용. |
| **`cortex-worker.test.mjs`** | 7 | 2 | **`scripts/cortex-worker.mjs` 및 PowerShell `cortex-worker`**: `.ps1`·`.cmd`·`.exe` 실행 파일 해석과 인자 보존, 환경 격리(`HERDR_CORTEX_ROLE=worker`, `HC_TERMINAL_ID` 제거), 임시 권한 파일 정리, `--out` UTF-8 저장, 시간 초과 시 프로세스 트리 종료, 무출력 감지, 인자 검증. |
| **`work-size.test.mjs`** | 18 | 1 | **작업 규모(S/L)·리마인더·명령 확인·의존 안내 훅과 `cortex-work`**: 편집 한도 경계(1파일, 1,000자 vs 1,001자, 도구별 글자 합산, 막힌 편집 제외, 프로젝트 밖·`.memory/` 제외), 하위 폴더 `cwd`에서도 `L` 유지·상위 파일 합산(`CLAUDE_PROJECT_DIR` 유무 모두)과 다른 프로젝트 편집 시 기존 폴더 `L` 보존·v1 상태 파일 호환·깨진 파일 복구·I/O 실패 통과, 30일 지난 `session-*.json` 및 빈 `S` 폴더 항목 정리, 워커·서브에이전트·제외 프로젝트·`workSize.enabled: false`·설정 검증, 셸 종류별(`Bash`/`PowerShell`/`cmd`) 따옴표·`$'…'`·백슬래시·백틱·PowerShell 둥근 따옴표와 엔대시/엠대시·닫는 줄이 확인된 히어독·`<<<` 여기-문자열·치환·중첩 셸(`eval`/`iex`/`cmd /c"…"`)·닫히지 않은 인용 비삼킴 처리, 조각 내 어느 자리의 방아쇠 낱말이든 검사하되 비파괴 `git`·비실행 패키지 관리자·`grep`/`Select-String` 뒤 인자 자리 낱말 제외와 `npx`/`dlx`/`exec` 유지 및 5겹 이상 중첩·작업량 상한 초과 시 차단(`powershell -EncodedCommand` 포함), `git commit`(조각 내 비선두·치환·중첩 셸 포함) 참·거짓 판정과 누적 초기화, 검수 판정(`ACCEPT`/`NEEDS_FIX`, 서술 어미·부정 표현·낱말 경계·주석 병기·루브릭 제외 포함) 파싱·L 종료·`cortex-worker --role reviewer`, 미저장 리마인더(1회+주기 동반)·주기 리마인더·세션 시작 카운터 초기화, 읽기 26번째 안내와 `0`일 때 무입출력, `PostToolUseFailure` 수정 실패 반복 차단(읽기 전용 명령 실패·성공 제외 포함)과 초기화(성공·커밋·저장·`reset`·사용자 중단 제외), 되돌리기 어려운 셸 명령 확인(주 대화 `ask`, 워커·서브에이전트 `deny`, `git rebase` 진행 중 플래그·`+refspec`·`npm`/`pnpm`/`yarn publish`·`xargs`/`find`/`rimraf`·`cmd /c`·`cmd //c` `rmdir /s`·셸별 임시 폴더 변수 `${env:TEMP}` 예외, 사용자 정규식 `node:vm` 시간 상한, 우선순위), 계약 파일 glob 차단과 기억 그래프 의존 안내(승인 폴더 읽기 전용 조회·잠금 시 빠른 생략·Windows 대소문자 무시·200ms 상한), `cortex-work` 폴더별·`--all` 안내·직접 실행 무경고와 상태 폴더·`cortex-work` 셸 호출 보호(보수적 기본값 + 비실행 파일 인자·`status`/`--help` 예외), 동시 훅 프로세스 무유실, 설치기 `PostToolUseFailure`·읽기 매처 등록·교체·제거. |
| **합계** | **219** | **14** | |

`{ skip: ... }` 옵션 없이 테스트 본문 안에서 `process.platform === 'win32'`일 때만 실행하는 단언도 여러 파일에 있습니다(대소문자만 다른 경로 표기, `.memory.` 같은 Windows 전용 경로 표기, `cmd.exe`·PowerShell로 훅 명령 실행, 잠긴 DB 파일 삭제). 이런 테스트는 다른 운영체제에서 건너뛰지 않고 그 단언만 빼고 실행됩니다.

---

## 실물과 대역

| 대상 | 실물로 실행하는 것 | 대역으로 바꾼 것 |
| :--- | :--- | :--- |
| 파일 시스템, SQLite | 임시 폴더의 실제 파일과 `node:sqlite`, `sqlite-vec` 확장(벡터 테이블). 정션도 실제로 만듭니다. | 없음 |
| MCP 서버 | 대부분 프로세스 안에서 `createMcpServer`/`createServerRuntime`/`createToolRegistry`를 만들어 메시지를 직접 넘깁니다. `search-rrf`, `core-robustness`, `config-and-embeddings`는 `src/mcp/server.mjs`를 자식 프로세스로 띄워 stdio로 주고받습니다. | Claude Code나 Antigravity가 서버에 접속하는 과정은 실행하지 않습니다. |
| 훅 | 대부분 훅 처리 함수를 직접 호출합니다. `hook-hardening`, `hooks-and-budget`, `injection-guards`, `trust-confirm`, `installer`는 훅 스크립트를 자식 프로세스로도 실행합니다. | Claude Code와 Antigravity는 실행하지 않습니다. 훅 입력과 대화 기록(JSONL)은 테스트가 직접 쓴 것입니다. |
| `hc` (Herdr의 탭 제어 명령) | 실행하지 않습니다. | 릴레이 도구를 호출하는 테스트는 모두 `hc` 클라이언트를 주입합니다. `relay-inbox`, `hc-status`, `injection-guards`는 `createHcClient`에 가짜 `execFileSync`를 넣어 표에서 답하게 하며 프로세스를 시작하지 않고, `core-robustness`는 클라이언트 자리에 메서드 세 개짜리 객체를 넣습니다. 출력 모양은 `hc` 0.1.21의 실제 출력을 본뜬 것이고, `hc send` 실패 중 실제 탭에서 얻은 것은 blocked(종료 코드 9)뿐이며 나머지 실패 메시지는 대역입니다. `injection-guards`의 `hc.exe` 파일들은 Node 실행 파일의 복사본으로, 경로만 다르고 실행되지 않습니다. `powershell-scripts`는 가짜 `hc.cmd`(안에서 `fake-hc.mjs` 실행)가 든 폴더만 자식 PowerShell의 PATH에 넣고, `hc send`로 넘어온 줄을 파일에 기록합니다. |
| `claude`, `agy` CLI | 실행하지 않습니다. | `installer.test.mjs`의 `makeFakeClaudeCli`가 `claude mcp add`/`remove` 호출을 기록하고 테스트 홈의 `.claude.json`을 같은 방식으로 고칩니다(설치기의 `claudeCli`·`runCli` 옵션으로 주입). 그 밖의 설치 테스트는 테스트 홈 방식이라 설치기가 `claude` CLI를 찾지 않습니다. 탭 복구 테스트는 탭에 입력될 명령 줄(`claude --resume ...`, `agy -c` 등)이 맞는지만 확인합니다. |
| 임베딩 서비스 | 외부 네트워크 요청은 없습니다. Ollama 프로바이더와 MCP 서버 자식 프로세스는 테스트가 `127.0.0.1`에 띄운 HTTP 대역 서버(`POST /api/embed`)에 실제로 요청합니다. | 프로바이더 대역(`makeProvider`, `createMockProvider`: 고정 또는 규칙 기반 벡터, 실패 모드 지정)과, Gemini·OpenAI·Ollama 프로바이더에 주입하는 `fetchImpl`(가짜 응답). ONNX 프로바이더는 `auto` 선택 순서와 상태 설명만 단언하며 `src/embeddings/onnx.mjs`를 직접 불러오는 테스트는 없습니다. |
| PowerShell 스크립트 | Windows PowerShell 5.1을 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`로 실제 실행합니다(`Bypass`는 그 프로세스에만 적용). `install.ps1`·`uninstall.ps1`, `scripts/install-tools.ps1`, `scripts/revive-agents.ps1`, `scripts/auto-revive.ps1`, `scripts/store-location.ps1`이 대상입니다. | 테스트 홈(`HERDR_CORTEX_TEST_HOME`)과 임시 파일만 상대합니다. 자식의 `USERPROFILE`은 실제 홈 대역 폴더이고 PATH에는 Windows 폴더(와 가짜 `hc` 폴더)만 있습니다. 실행 정책은 `HERDR_CORTEX_TEST_EXECUTION_POLICY` 환경 변수로 흉내 낸 값을 읽고 변경은 테스트 홈의 `test-execution-policy.txt`에 기록되므로 실제 정책은 읽지도 바꾸지도 않습니다. 실제 프로필 파일도 건드리지 않습니다. |
| 확인 대화상자 | 화면에 띄우지 않습니다. 조건부 테스트 하나가 실제 PowerShell로 대화상자 스크립트를 실행합니다. | 그 테스트는 `MessageBox.Show`를 부르는 한 줄(`CONFIRM_DIALOG_SHOW_LINE`)만 스스로 답하는 줄로 바꿉니다. 나머지 테스트는 `runTrustCli`에 `confirm` 함수를 주입하거나 `showWindowsConfirmDialog`에 가짜 `spawn`을 넣습니다. `trust-cli.mjs approve`·`acknowledge`를 자식 프로세스로 실행할 때는 `support/no-dialog-env.mjs`의 환경을 써서 PowerShell을 찾지 못하게 하고, 종료 코드 2로 거부하는지 확인합니다. |

---

## 실행 조건과 건너뛰기

| 조건 | 필요한 테스트 | 조건이 맞지 않을 때 |
| :--- | :--- | :--- |
| Node.js `>=22.13.0` (`package.json`의 `engines`) | 전체. `node:sqlite`를 소스와 테스트가 직접 씁니다. | 버전이 낮을 때 건너뛰는 장치는 없습니다. |
| `sqlite-vec` 패키지 (`npm install`) | 벡터 저장·검색을 단언하는 테스트(`search-rrf`, `config-and-embeddings`, `store-and-db`의 벡터 용량 테스트 등) | `src/core/db.mjs`는 패키지를 불러오지 못하면 벡터 기능 없이 동작하지만, 테스트에는 이 경우의 건너뛰기가 없습니다. 벡터를 단언하는 테스트는 실패합니다. |
| Windows이면서 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`가 존재 | `powershell-scripts.test.mjs` 7개, `powershell-store-location.test.mjs` 3개, `cortex-worker.test.mjs` 2개, `trust-confirm.test.mjs` 1개, `work-size.test.mjs` 1개 | 14개 모두 `Windows PowerShell is not available`(또는 Windows 미지원) 사유로 건너뜁니다(실패가 아님). |
| 셸 (`installer.test.mjs`의 Antigravity 훅 명령 테스트) | Windows에서는 `cmd.exe`와 이름으로 찾은 `powershell.exe`로 명령을 실행하고, `%ProgramFiles%\Git\bin\bash.exe`가 있으면 Git Bash로도 실행합니다. 다른 운영체제에서는 `/bin/bash`가 있을 때 실행합니다. | 건너뛰기 옵션이 없습니다. Windows에서 `powershell.exe`를 실행하지 못하거나 어느 셸도 실행하지 못하면 실패합니다. bash가 없으면 bash 부분만 생략됩니다. |
| 정션 생성 (`fs.symlinkSync(..., 'junction')`) | `core-robustness`, `config-and-embeddings`, `hook-hardening`, `injection-guards`, `project-trust`, `relay-inbox`, `trust-confirm`의 경로 별칭 테스트 | 건너뛰기 옵션이 없습니다. 링크를 만들지 못하면 그 테스트가 실패합니다. |
| 네트워크, 실제 `hc`·`claude`·`agy`·Herdr | 필요 없습니다. | 해당 없음 |

---

## 확인 상태

자동 테스트는 가짜 `hc`, 가짜 임베딩 서버, 가짜 `claude` 명령, 격리된 홈 폴더를 씁니다(위 [실물과 대역](#실물과-대역)). 그래서 테스트가 통과한다는 것과 실제 환경에서 직접 보았다는 것은 다릅니다. 실제 환경에서 직접 본 것과 그렇지 못한 것은 모듈마다 그 모듈의 README에 "확인 상태" 절로 적었고, 전체 목록은 [루트 README](../README.md#확인-상태와-알려진-한계)에 있습니다. 거기서 말하는 "개발 PC"는 Windows 11, Node 26.13.1, `hc` 0.1.21, Claude Code 2.1.330이 설치된 한 대이며, 이 PC에 `install.ps1`로 실제 설치해 본 결과도 함께 적혀 있습니다.

테스트 실행 환경에 대해 확인하지 못한 것은 다음 하나입니다. 무엇을 확인하지 못했는지, 왜 못 했는지, 지금 무엇을 근거로 삼고 있는지, 어떻게 확인하면 되는지, 가정이 틀렸을 때 어떤 증상이 나오는지를 적었습니다.

### Node 22

| | |
| :--- | :--- |
| **무엇을** | 최소 지원 버전인 Node 22.13에서의 동작 |
| **왜 못 했나** | 모든 실행과 자동 테스트를 Node 26.13.1에서만 했습니다. |
| **지금의 근거** | `package.json`의 `engines`와 설치 스크립트의 버전 검사가 22.13.0 이상을 요구한다는 것뿐입니다. |
| **확인 방법** | Node 22.13에서 `npm test`를 실행합니다. |
| **틀렸을 때 증상** | 테스트 실패나 실행 오류. 받은편지함의 이름 바꾸기 문제(두 프로세스가 같은 파일의 이름을 동시에 바꾸면 둘 다 성공으로 보고될 수 있음, [`src/relay/README.md`](../src/relay/README.md#확인-상태))가 Node 22에도 있는지는 모르지만, 잠금 파일 방식이라 어느 쪽이든 안전합니다. |

---

## 저장소 청정도 검사의 범위

`orchestration-prompts.test.mjs`의 `repository purity: ...` 테스트는 다음만 검사합니다.

- **검사 대상 파일**: `prompts/` 아래의 모든 파일과 `src/core/` 아래의 모든 파일(하위 폴더 포함, 그 안의 `README.md` 포함), 그리고 저장소 루트의 `README.md` 한 개. 앞의 두 폴더에서 모은 파일이 20개 미만이면 실패합니다. `src/`의 다른 폴더, `scripts/`, `test/`, 루트의 `.ps1`, 다른 폴더의 README는 검사하지 않습니다.
- **`prompts/`·`src/core/`·루트 `README.md`에 공통으로 적용하는 패턴**(정규식, 파일당 패턴마다 첫 일치만 보고):

| 이름 | 정규식 |
| :--- | :--- |
| POSIX `/Users/` 경로 | `/\/Users\/[A-Za-z0-9._-]+/` |
| POSIX `/home/` 경로 | `/\/home\/[A-Za-z0-9._-]+/` |
| Windows 사용자 폴더 경로 | `/C:[\\/]Users[\\/]/i` |
| 고정된 작업 폴더 경로 | `/G:[\\/]herdr-custom-app/i` |
| `claude -p ... --resume` 재귀 호출 | `/claude\s+-p\b[^\n]*--resume/i` |
| 현재 OS 사용자 이름 | `os.userInfo().username`이 3자 이상일 때만, 그 이름을 `\b이름\b`로 감싸 대소문자 구분 없이 검사 |

- **`prompts/`·`src/core/`에만 추가로 적용하는 패턴**: `/head-agent-core/i`. 루트 `README.md`에는 적용하지 않습니다.

이 테스트는 위 패턴의 문자열 검사이며 API 키나 토큰 같은 비밀 값을 찾는 패턴은 없습니다. 사용자 이름 패턴의 `\b`는 ASCII 문자 기준의 단어 경계이므로 한글처럼 ASCII가 아닌 문자로만 된 사용자 이름은 사실상 걸리지 않습니다. 반대로 Windows 경로 패턴은 사용자 이름 부분을 보지 않으므로, 검사 대상 문서에 `C:\Users\`로 시작하는 예시 경로를 자리표시자와 함께 쓰더라도 테스트가 실패합니다. 그런 문서에서는 `%USERPROFILE%`이나 `~` 표기를 씁니다.
