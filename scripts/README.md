# `scripts/` — PowerShell 셸 명령 · 탭 복구 · 설치 보조 · 상태 진단

> [← 루트 README](../README.md)

이 폴더에는 사용자의 PowerShell에서 직접 쓰는 것들이 들어 있습니다. PowerShell 프로필이 불러오는 스크립트(`auto-revive.ps1`)가 셸 명령 다섯 개를 만들고, 재부팅 뒤 빈 셸로 다시 열린 Herdr 탭에서 에이전트를 되살립니다. 루트의 [`install.ps1`](../install.ps1)과 [`uninstall.ps1`](../uninstall.ps1)이 쓰는 보조 함수, `cortex-status` 명령의 본체, 그리고 예전 호출 방식을 위한 얇은 Node 래퍼 두 개도 여기에 있습니다.

Windows PowerShell 5.1과 PowerShell 7 이상에서 동작하도록 작성되어 있습니다. 다만 자동 테스트는 Windows PowerShell 5.1(`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`)로만 실행합니다.

---

## 파일 구성

| 파일 | 실행 방식 | 역할 | 정의하는 것 |
| :--- | :--- | :--- | :--- |
| **`auto-revive.ps1`** | PowerShell 프로필이 점(`.`)으로 불러옴 | 셸 명령을 만들고, 셸이 시작될 때 이 탭을 자동으로 복구합니다. | 전역 함수(셸 명령) `revive-agents`, `revive-agy`, `revive-status`, `cortex-trust`, `cortex-status`. 내부 함수 `Get-HerdrRecordedNode`, `Resolve-HerdrNode`, `Write-HerdrNodeMissing`, `Invoke-HerdrNodeScript`, `Invoke-HerdrHcJson`, `Get-HerdrAutoRevivePlan`, `Invoke-HerdrAutoRevive` |
| **`revive-agents.ps1`** | 직접 실행(`revive-agents` 명령이 호출) | `hc ls --json`으로 탭 목록을 읽고, 빈 셸 탭마다 복구 명령을 `hc send`로 입력합니다. | 매개변수 `-DryRun`, `-Status`, `-DelayMs <밀리초>`(기본 300) |
| **`revive-common.ps1`** | 점으로 불러옴 | 위 두 스크립트가 함께 쓰는 판정 함수입니다. 탭 하나에 무엇을 할지는 여기서만 정합니다. | `Test-HerdrTerminalId`, `Test-HerdrSessionId`, `ConvertTo-HerdrPathKey`, `Test-HerdrBareShell`, `Get-HerdrTerminalMeta`, `Read-HerdrSavedSession`, `Read-HerdrReviveConfig`, `Get-HerdrTitleAgent`, `Get-HerdrRunningAgent`, `Get-HerdrAgentExe`, `Format-HerdrSetLocation`, `Resolve-HerdrRevivePlans` |
| **`store-location.ps1`** | 점으로 불러옴 | 홈 폴더와 전역 저장소 위치를 정하는 한 곳입니다. Node 쪽의 `resolveHomeDir`·`resolveGlobalDir`([`src/core/config.mjs`](../src/core/README.md))와 같은 순서를 씁니다. | `Get-HerdrTestHome`, `Get-HerdrEffectiveHome`, `Get-HerdrCortexGlobalDir` |
| **`install-tools.ps1`** | 점으로 불러옴. `-Action`을 주면 한 가지 작업을 하고 결과를 JSON 한 줄로 출력 | 프로필 블록을 파일의 원래 인코딩 그대로 넣고 빼는 함수와 실행 정책 기록 함수입니다. | `Get-HerdrBackupStamp`, `New-HerdrDatedBackup`, `Get-HerdrAnsiEncoding`, `Get-HerdrTextEncoding`, `Test-HerdrBytesEqual`, `ConvertTo-HerdrFileBytes`, `Read-HerdrProfile`, `Find-HerdrBlockSpans`, `Remove-HerdrSpans`, `Get-HerdrLineBreak`, `Set-HerdrBlockInText`, `Remove-HerdrBlockFromText`, `Set-HerdrProfileBlock`, `Remove-HerdrProfileBlock`, `ConvertTo-HerdrPathExpression`, `Get-HerdrProfileBlockLines`, `Get-HerdrPolicyState`, `Set-HerdrCurrentUserPolicy`, `Test-HerdrPolicyBlocksProfile`, `Get-HerdrPolicyRecordPath`, `Read-HerdrPolicyRecord`, `Write-HerdrPolicyRecord` |
| **`cortex-status.mjs`** | `node --no-warnings scripts/cortex-status.mjs [--cwd <폴더>] [--json]` | `cortex-status` 명령의 본체입니다. 설정 파일과 로컬 색인만 읽고 네트워크 요청은 하지 않습니다. | Export: `collectStatus`, `formatStatus` |
| **`merge-hooks.mjs`** | `node scripts/merge-hooks.mjs <install\|uninstall> [repoRoot]` | [`src/hooks/installer.mjs`](../src/hooks/README.md)의 `installCortex`·`uninstallCortex`를 그대로 부르는 래퍼입니다. 인자가 `install`도 `uninstall`도 아니면 사용법을 출력하고 종료 코드 1로 끝납니다. | Export 없음(불러오는 즉시 실행됨) |
| **`record-session.mjs`** | `node scripts/record-session.mjs <antigravity\|claude>` (표준 입력으로 훅 JSON) | [`src/revive/tracker.mjs`](../src/revive/README.md)의 `recordSession`을 부르는 래퍼입니다. 오류가 나도 항상 종료 코드 0으로 끝나며, `antigravity`일 때는 `{}`를 출력합니다. | Export 없음(불러오는 즉시 실행됨) |

---

## 셸 명령

프로필이 불러와진 PowerShell 창에서는 어느 폴더에서나 아래 명령을 쓸 수 있습니다.

| 명령 | 하는 일 |
| :--- | :--- |
| `cortex-status` | 설치 상태와 현재 폴더의 상태를 한 화면에 보여 줍니다(아래 "진단 항목"). |
| `cortex-trust approve [폴더]` | 그 폴더 하나를 승인합니다. 확인 대화상자가 먼저 뜨고 "예"를 눌러야 승인됩니다. |
| `cortex-trust revoke [폴더]` | 승인을 거둡니다. 대화상자는 뜨지 않습니다. |
| `cortex-trust status [폴더]` | 승인 여부를 보여 줍니다. 종료 코드는 승인됨 0, 승인 안 됨 1입니다. |
| `cortex-trust list` | 승인된 폴더를 모두 보여 줍니다. |
| `cortex-trust acknowledge` | 대화상자를 거치지 않고 바뀐 승인 목록을, 대화상자로 확인한 뒤 받아들입니다. |
| `revive-agents` | 빈 셸 상태인 탭을 모두 복구합니다. |
| `revive-agents -DryRun` | 아무것도 입력하지 않고, 탭마다 무엇을 할지와 건너뛰는 이유만 출력합니다. |
| `revive-status` | 살아 있는 탭과 탭별로 저장된 세션을 보여 줍니다(`revive-agents -Status`와 같음). |
| `revive-agy` | `revive-agents`와 같은 동작을 하는 다른 이름입니다. |

`cortex-trust`와 `cortex-status`는 `node`를 PATH에서 찾지 않습니다. 설치할 때 기록된 Node 경로(`<전역 저장소>\state\install.json`의 `nodePath`)가 있으면 그것으로 실행하고, 그 파일이 없거나 경로가 사라졌을 때만 PATH의 `node`를 씁니다. 둘 다 없으면 무엇이 없는지와 "Node.js 22.13 이상을 설치하고 `install.ps1`을 다시 실행하라"는 안내를 출력합니다.

`cortex-trust`에 폴더를 주지 않으면 이 셸의 현재 폴더가 대상입니다. 승인의 뜻과 대화상자의 동작은 [`src/core/README.md`](../src/core/README.md)에 있습니다.

### `cortex-status` 진단 항목

`cortex-status.mjs`의 `collectStatus()`가 모으고 `formatStatus()`가 아래 줄로 출력합니다. `--json`을 주면 같은 내용을 JSON으로 출력합니다.

| 줄 | 내용 |
| :--- | :--- |
| `Repo`, `Global store` | 저장소 폴더와 전역 저장소 폴더(아직 없으면 그렇게 표시) |
| `Node`, `recorded` | 지금 실행 중인 Node의 버전(22.13 미만이면 `TOO OLD`)과 경로, 설치할 때 기록된 Node 경로가 아직 있는지 |
| `sqlite-vec` | 벡터 검색에 쓰는 `sqlite-vec` 패키지를 불러올 수 있는지 |
| `Claude hooks` | `~/.claude/settings.json`에 이벤트별 훅이 올바르게 등록되어 있는지 |
| `Claude MCP` | `~/.claude.json`에 `herdr-cortex` 서버가 등록되어 있는지, 그 항목의 Node 경로와 `server.mjs`가 있는지 |
| `Antigravity` | 설치기와 같은 기준(`~/.gemini` 폴더가 있거나 PATH에 `agy`가 있음)으로 Antigravity가 있다고 볼 때 훅과 MCP 등록 상태. 줄 끝의 `found by:`가 근거를 알려 줍니다(`~/.gemini folder` 또는 `"agy" on PATH`). PATH의 `agy`만 있고 아직 등록되지 않았으면 `missing`으로 나오고 다시 설치하라는 주의 항목이 붙습니다. 둘 다 없으면 `not found (no "agy" on PATH and no ~/.gemini folder)` |
| `This folder`, `approved`, `enabled` | 현재 폴더의 승인 여부, 설정으로 제외되었는지와 그 이유, `headCore`, `hookBudget` |
| `Approvals` | 승인된 폴더 수, 대화상자 없이 추가되거나 빠진 폴더 |
| `Embedding` | 임베딩이 꺼져 있는지, 켜져 있으면 어느 프로바이더·모델·호스트로 보내는지, 포기한 문서 수 |
| `Index` | 계층(project, global)별 문서 수와 임베딩 상태, 아직 색인되지 않은 문서 수, 중복 ID 수 |
| `Relay inbox` | 이 탭의 받은편지함(대기, 전달 후 보관, 깨진 파일 수). Herdr 탭이 아니면 메시지가 있는 받은편지함 목록 |
| `Config` | 설정 파일에서 발견한 문제 수 |
| `Result` 또는 `Needs attention` | 문제가 없으면 한 줄, 있으면 주의할 항목 목록 |

중복 ID와 미색인 문서를 세기 위해, 열 수 있는 계층에는 기억 도구가 평소에 하는 것과 같은 색인 동기화를 한 번 실행합니다. 승인되지 않았거나 제외된 폴더의 프로젝트 계층은 읽지 않고 그 이유만 표시합니다.

Node 진단 뒤에 `auto-revive.ps1`이 저장된 세션 파일 수(`Saved sessions: cortex=…, legacy=…`)를 덧붙이고, `hc`가 PATH에 있으면 `revive-status`의 출력도 이어서 보여 줍니다.

---

## 탭 복구

Herdr는 재부팅하거나 코어를 다시 시작하면 에이전트가 돌던 탭을 빈 PowerShell로 다시 엽니다. 훅이 탭별로 기록해 둔 세션 ID([`src/revive/`](../src/revive/README.md))를 써서 그 탭에서 같은 대화를 다시 여는 것이 탭 복구입니다. 저장된 세션은 `<전역 저장소>\sessions\<탭 ID>.json`에서 먼저 찾고, 없으면 이전 도구(herdr-revive)의 `~\.herdr-revive\sessions\`에서 찾습니다.

복구에는 두 경로가 있고, 무엇을 할지는 둘 다 `Resolve-HerdrRevivePlans` 하나가 정합니다.

- **한꺼번에**: `revive-agents`가 `hc ls --json`의 모든 탭을 보고, 복구할 탭마다 명령 한 줄을 `hc send <탭> <명령>`으로 입력합니다. 탭 사이에 `-DelayMs`(기본 300밀리초)만큼 쉽니다.
- **자동으로**: 프로필이 `auto-revive.ps1`을 불러올 때 그 탭 스스로 판단해, 복구 대상이면 에이전트를 직접 실행합니다.

### 탭 하나에 대한 판정

| 탭의 상태 | 하는 일 |
| :--- | :--- |
| 탭의 `state`가 `live`가 아님 | 대상에서 뺍니다. |
| 탭 ID가 형식에 맞지 않음(영문·숫자로 시작, 영문·숫자·`_`·`-` 최대 64자, Windows 예약 장치 이름 제외) | 건너뜁니다(`invalid terminal id`). |
| 셸이 아닌 프로그램이 떠 있음(`hc`가 알려 주는 프로그램 이름이 `powershell.exe`, `pwsh.exe`, `cmd.exe`, `bash.exe`, `nu.exe`, `powershell`, `pwsh`, `cmd`가 아님) | 이미 실행 중으로 보고 건드리지 않습니다. |
| 빈 셸이고, 이 탭에 저장된 세션 ID가 있으며, 저장된 폴더가 탭의 현재 폴더와 같거나 저장된 폴더 정보가 없음 | `claude --resume <세션 ID>` 또는 `agy --conversation <세션 ID>`를 실행합니다. |
| 위와 같지만 저장된 폴더가 탭의 현재 폴더와 다름 | 저장된 폴더로 먼저 이동한 뒤 같은 명령을 실행합니다. 입력되는 줄은 `Set-Location -LiteralPath '<폴더>'; claude --resume <세션 ID>` 모양이며, 폴더 경로는 작은따옴표 안의 글자로만 들어갑니다. |
| 저장된 폴더가 더 이상 없음(또는 절대 경로가 아님) | 건너뜁니다. 탭 제목으로 추측하는 단계로 넘어가지 않습니다. |
| 저장된 폴더가 다른데 탭의 셸이 PowerShell이 아님(`cmd.exe` 등) | 건너뛰고, 그 폴더로 직접 이동해 실행할 명령을 알려 줍니다. |
| 저장된 세션 ID가 형식에 맞지 않음(영문·숫자·`.`·`_`·`-` 1~128자, `..` 금지) | 그 기록을 무시한다고 알리고 아래의 탭 제목 판정으로 넘어갑니다. |
| 쓸 수 있는 기록이 없고, 탭 제목에 `/ Claude`(또는 `/ Claude Code`)나 `/ Antigravity`가 들어 있음(대소문자 구분 없음) | 제목으로 에이전트를 추측해 `claude -c` 또는 `agy -c`를 실행합니다. `-c`는 그 폴더의 가장 최근 대화를 잇는 옵션입니다. |
| 위와 같지만 같은 폴더에 같은 에이전트의 살아 있는 탭이 하나 더 있음(실행 중이거나 함께 복구될 탭) | 건너뜁니다. `-c`로는 두 탭의 대화를 구분할 수 없기 때문이며, 서로 겹치는 탭은 양쪽 모두 건너뜁니다. 이유와 함께 `claude --resume`으로 직접 고르라는 안내가 출력됩니다. |
| 기록도 없고 제목에도 에이전트 이름이 없음 | 일반 셸로 보고 아무것도 하지 않습니다. |

전역 `config.json`(없으면 `~\.herdr-revive\config.json`)에 `claudeExtraArgs`나 `agyExtraArgs` 배열이 있으면, 위에서 만든 명령의 뒤에 그대로 덧붙입니다. 예: `"claudeExtraArgs": ["--dangerously-skip-permissions"]`.

같은 폴더인지는 경로 문자열을 소문자로 바꾸고 `/`를 `\`로 바꾼 뒤 비교합니다. 정션이나 심볼릭 링크는 풀지 않으므로, 같은 폴더를 다른 경로로 연 탭은 다른 폴더로 봅니다. 탭의 폴더를 알 수 없으면(빈 값) 같은 폴더의 다른 탭을 찾는 검사는 하지 않습니다.

### `revive-agents`의 출력

탭마다 한 줄씩 `[REVIVE]`(입력함), `[DRYRUN]`(`-DryRun`일 때 입력할 내용), `[SKIP]`(이미 실행 중이거나 건너뜀과 그 이유), `[IGNORE]`(일반 셸), `[FAILED]`(`hc send`가 0이 아닌 종료 코드를 냄), `[NOTE]`(무시한 기록)가 출력되고, 끝에 복구·실행 중·건너뜀의 개수가 나옵니다. `hc`가 PATH에 없거나 `hc ls --json`이 실패하면 오류를 출력하고 종료 코드 1로 끝납니다.

### 자동 복구가 실행되는 조건

`auto-revive.ps1`은 셸마다 한 번만 시도하며, 아래 중 하나라도 해당하면 아무것도 하지 않습니다.

- `HC_TERMINAL_ID`가 없음(Herdr 탭이 아님) 또는 형식에 맞지 않음
- `HERDR_REVIVE_DISABLE`이 `1`임(`install.ps1 -NoAutoResume`로 설치하면 프로필 블록이 이 값을 넣습니다)
- `HERDR_REVIVE_IN_AGENT`가 `1`이거나 `CLAUDECODE`가 설정되어 있음(에이전트가 띄운 셸)
- 콘솔 호스트가 아니거나, 대화형이 아니거나, 표준 입력이 다른 곳에서 넘어옴
- `-Command`, `-File`, `-EncodedCommand`로 한 번 실행하고 끝나는 셸이며 `-NoExit`가 없음
- `hc get <탭>`이 이 탭에 셸이 아닌 프로그램이 있다고 알려 줌

판정은 위 표와 같습니다. 탭 제목으로 추측해야 하는 경우에는 `hc ls --json`으로 다른 탭을 확인하며, 그 목록을 읽지 못하면 추측하지 않고 건너뜁니다. 복구할 때는 `[herdr-cortex] Restoring … (Ctrl+C to cancel)`을 출력하고, 여러 탭이 동시에 시작하지 않도록 탭 ID에서 계산한 150~950밀리초를 기다린 뒤 에이전트를 실행합니다. 실행할 `claude`나 `agy`가 PATH에 없으면 조용히 그만둡니다.

---

## 설치 보조 함수 (`install-tools.ps1`)

- **프로필 블록**: `# >>> herdr-cortex >>>`와 `# <<< herdr-cortex <<<` 사이의 줄이 이 도구의 블록입니다. `Set-HerdrProfileBlock`은 파일을 원래 인코딩(BOM 있는 UTF-8, BOM 있는 UTF-16 LE/BE, BOM 없는 UTF-8, 그 밖에는 시스템 ANSI 코드 페이지)으로 읽고, 블록만 바꾼 뒤 같은 인코딩으로 다시 씁니다. 쓰기 전에 `<파일>.herdr-cortex.<yyyyMMdd-HHmmss>.bak`으로 복사하며, 같은 이름이 있으면 `-2`, `-3`을 붙입니다. 파일이 없으면 BOM 있는 UTF-8로 새로 만듭니다.
- **바꾸지 않는 경우**: 파일을 그 인코딩으로 해석할 수 없을 때, 다시 인코딩한 결과가 원래 바이트와 달라질 때, 블록의 글자를 그 인코딩으로 적을 수 없을 때, 시작 표시만 있고 끝 표시가 없을 때, UTF-32일 때는 파일을 건드리지 않고 `failed`와 이유를 돌려줍니다. 이때 `install.ps1`은 직접 넣을 줄을 화면에 보여 줍니다.
- **이전 도구의 블록**: `# >>> herdr-revive >>>` 블록은 설치와 제거 모두에서 함께 지웁니다.
- **경로 표기**: 블록 안의 `auto-revive.ps1` 경로는 ASCII 문자만 쓰는 PowerShell 식으로 적습니다(ASCII가 아닌 글자는 `[char]0xNNNN`). Windows PowerShell 5.1은 BOM 없는 프로필을 ANSI 코드 페이지로, PowerShell 7은 UTF-8로 읽기 때문에, 한글 폴더 이름이 있어도 두 버전에서 같은 경로가 되도록 한 것입니다.
- **실행 정책 기록**: 설치가 실행 정책을 바꾸면 이전 값과 새 값을 `<전역 저장소>\state\execution-policy.json`에 적습니다. 제거는 현재 값이 그 기록의 새 값과 같을 때만 이전 값으로 되돌립니다.
- **직접 호출**: `-Action ProfileSet -ProfilePath <파일> -BlockPath <블록 줄이 든 UTF-8 파일>`, `-Action ProfileRemove -ProfilePath <파일>`, `-Action PathExpression -Value <경로>`. 결과를 JSON 한 줄로 출력하고, 종료 코드는 성공 0, `failed` 1, 모르는 `-Action` 2입니다. 테스트가 임시 파일을 대상으로 이 방식을 씁니다.

---

## 환경변수

| 변수 | 읽는 곳 | 뜻 |
| :--- | :--- | :--- |
| `HC_TERMINAL_ID` | `auto-revive.ps1`, `cortex-status.mjs` | Herdr가 탭마다 넣어 주는 탭 ID입니다. 자동 복구의 대상과 `cortex-status`가 보여 줄 받은편지함을 정합니다. |
| `HERDR_REVIVE_DISABLE` | `auto-revive.ps1` | `1`이면 자동 복구만 끕니다. 셸 명령은 그대로 쓸 수 있습니다. |
| `HERDR_REVIVE_IN_AGENT` | `auto-revive.ps1` | 자동 복구가 에이전트를 실행하는 동안 `1`로 두어, 그 안에서 열린 셸이 다시 복구를 시도하지 않게 합니다. |
| `CLAUDECODE` | `auto-revive.ps1` | 값이 있으면 Claude Code가 띄운 셸로 보고 자동 복구를 하지 않습니다. |
| `HERDR_CORTEX_HOME` | `store-location.ps1` | 전역 저장소 폴더를 직접 지정합니다. |
| `HERDR_CORTEX_TEST_HOME`, `HERDR_REVIVE_TEST_HOME` | `store-location.ps1`, `install.ps1`, `uninstall.ps1` | 홈 폴더를 다른 폴더로 바꿉니다(테스트용). 이 값이 있으면 설치·제거는 실제 실행 정책과 실제 `$PROFILE`을 읽지도 바꾸지도 않습니다. |
| `HERDR_CORTEX_TEST_EXECUTION_POLICY` | `install-tools.ps1` | 테스트 홈에서 쓸 가짜 실행 정책(`<CurrentUser>,<LocalMachine>`)입니다. 테스트 홈이 아니면 무시합니다. |

홈 폴더는 `HERDR_CORTEX_TEST_HOME`, `HERDR_REVIVE_TEST_HOME`, `USERPROFILE` 순으로 정하고, 전역 저장소는 `HERDR_CORTEX_HOME`, 그다음 `<홈 폴더>\.herdr-cortex` 순으로 정합니다.

---

## 알아 둘 한계

- 탭 복구가 실제 Herdr 탭에 입력하는 동작은 자동 테스트에서 가짜 `hc`로만 실행했습니다. 처음에는 `revive-agents -DryRun`으로 계획을 확인하세요.
- `revive-agents`는 빈 셸의 종류를 가리지 않고 명령을 입력합니다. 폴더 이동이 필요한 경우에만 PowerShell인지 확인합니다.
- `hc send`가 실패한 탭(`[FAILED]`)에는 아무것도 입력되지 않았으므로 그 탭에서 직접 명령을 실행해야 합니다.

---

## 관련 테스트

- [`test/powershell-scripts.test.mjs`](../test/powershell-scripts.test.mjs): 프로필 블록의 인코딩 보존과 백업, `revive-agents`와 자동 복구의 판정, 셸 명령이 기록된 Node 경로로 실행되는지, 테스트 홈에서의 `install.ps1`·`uninstall.ps1`
- [`test/powershell-store-location.test.mjs`](../test/powershell-store-location.test.mjs): PowerShell 스크립트와 Node 쪽이 같은 전역 저장소 위치를 고르는지
- [`test/cortex-status.test.mjs`](../test/cortex-status.test.mjs): `collectStatus`·`formatStatus`
- [`test/trust-confirm.test.mjs`](../test/trust-confirm.test.mjs): 승인 목록 변경이 `cortex-status`에 표시되는지
- [`test/hooks-and-budget.test.mjs`](../test/hooks-and-budget.test.mjs), [`test/installer.test.mjs`](../test/installer.test.mjs): 이전 도구가 등록한 `record-session.mjs` 훅을 알아보는지

전체 목록과 개수는 [`test/README.md`](../test/README.md)에 있습니다.
