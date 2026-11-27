# `scripts/` — PowerShell 셸 명령 · 탭 복구 · 설치 보조 · 상태 진단

> [← 루트 README](../README.md)

이 폴더에는 사용자의 PowerShell에서 직접 쓰는 것들이 들어 있습니다. PowerShell 프로필이 불러오는 스크립트(`auto-revive.ps1`)가 셸 명령 여섯 개를 만들고, 재부팅 뒤 빈 셸로 다시 열린 Herdr 탭에서 에이전트를 되살립니다. 루트의 [`install.ps1`](../install.ps1)과 [`uninstall.ps1`](../uninstall.ps1)이 쓰는 보조 함수, `cortex-status`와 `cortex-worker` 명령의 본체, 그리고 예전 호출 방식을 위한 얇은 Node 래퍼 두 개도 여기에 있습니다.

Windows PowerShell 5.1과 PowerShell 7 이상에서 동작하도록 작성되어 있습니다. 다만 자동 테스트는 Windows PowerShell 5.1(`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`)로만 실행합니다.

---

## 파일 구성

| 파일 | 실행 방식 | 역할 | 정의하는 것 |
| :--- | :--- | :--- | :--- |
| **`auto-revive.ps1`** | PowerShell 프로필이 점(`.`)으로 불러옴 | 셸 명령을 만들고, 셸이 시작될 때 이 탭을 자동으로 복구합니다. | 전역 함수(셸 명령) `revive-agents`, `revive-agy`, `revive-status`, `cortex-trust`, `cortex-status`, `cortex-worker`. 내부 함수 `Get-HerdrRecordedNode`, `Resolve-HerdrNode`, `Write-HerdrNodeMissing`, `Invoke-HerdrNodeScript`, `Invoke-HerdrHcJson`, `Get-HerdrAutoRevivePlan`, `Invoke-HerdrAutoRevive` |
| **`revive-agents.ps1`** | 직접 실행(`revive-agents` 명령이 호출) | `hc ls --json`으로 탭 목록을 읽고, 빈 셸 탭마다 복구 명령을 `hc send`로 입력합니다. | 매개변수 `-DryRun`, `-Status`, `-DelayMs <밀리초>`(기본 300) |
| **`revive-common.ps1`** | 점으로 불러옴 | 위 두 스크립트가 함께 쓰는 판정 함수입니다. 탭 하나에 무엇을 할지는 여기서만 정합니다. | `Test-HerdrTerminalId`, `Test-HerdrSessionId`, `ConvertTo-HerdrPathKey`, `Test-HerdrBareShell`, `Get-HerdrTerminalMeta`, `Read-HerdrSavedSession`, `Read-HerdrReviveConfig`, `Get-HerdrTitleAgent`, `Get-HerdrRunningAgent`, `Get-HerdrAgentExe`, `Format-HerdrSetLocation`, `Resolve-HerdrRevivePlans` |
| **`store-location.ps1`** | 점으로 불러옴 | 홈 폴더와 전역 저장소 위치를 정하는 한 곳입니다. Node 쪽의 `resolveHomeDir`·`resolveGlobalDir`([`src/core/config.mjs`](../src/core/README.md))와 같은 순서를 씁니다. | `Get-HerdrTestHome`, `Get-HerdrEffectiveHome`, `Get-HerdrCortexGlobalDir` |
| **`install-tools.ps1`** | 점으로 불러옴. `-Action`을 주면 한 가지 작업을 하고 결과를 JSON 한 줄로 출력 | 프로필 블록을 파일의 원래 인코딩 그대로 넣고 빼는 함수와 실행 정책 기록 함수입니다. | `Get-HerdrBackupStamp`, `New-HerdrDatedBackup`, `Get-HerdrAnsiEncoding`, `Get-HerdrTextEncoding`, `Test-HerdrBytesEqual`, `ConvertTo-HerdrFileBytes`, `Read-HerdrProfile`, `Find-HerdrBlockSpans`, `Remove-HerdrSpans`, `Get-HerdrLineBreak`, `Set-HerdrBlockInText`, `Remove-HerdrBlockFromText`, `Set-HerdrProfileBlock`, `Remove-HerdrProfileBlock`, `ConvertTo-HerdrPathExpression`, `Get-HerdrProfileBlockLines`, `Get-HerdrPolicyState`, `Invoke-HerdrPolicyChange`, `Set-HerdrCurrentUserPolicy`, `Test-HerdrPolicyBlocksProfile`, `Get-HerdrPolicyRecordPath`, `Read-HerdrPolicyRecord`, `Write-HerdrPolicyRecord` |
| **`cortex-status.mjs`** | `node --no-warnings scripts/cortex-status.mjs [--cwd <폴더>] [--json]` | `cortex-status` 명령의 본체입니다. 설정 파일과 로컬 색인만 읽고 네트워크 요청은 하지 않습니다. | Export: `collectStatus`, `formatStatus` |
| **`cortex-worker.mjs`** | `node --no-warnings scripts/cortex-worker.mjs --role <developer\|coder\|reviewer> --agent <antigravity\|claude> --model <모델> --brief <지시 파일> [--out <결과 파일>] [--timeout <분>] [--allow <규칙>]... [--cwd <폴더>]` | `cortex-worker` 명령의 본체입니다. 환경 변수와 세션 한정 권한을 맞추어 `agy -p` 또는 `claude -p` 헤드리스 워커를 실행합니다. | Export: `VALID_ROLES`, `DEFAULT_TIMEOUT_MINUTES`, `WORKER_USAGE`, `HOST_SPECS`, `formatAgyTimeout`, `buildWorkerEnv`, `buildWorkerPrompt`, `parseWorkerArgs`, `resolveExecutable`, `quoteCmdArg`, `buildSpawnSpec`, `runWorker` |
| **`merge-hooks.mjs`** | `node scripts/merge-hooks.mjs <install\|uninstall> [repoRoot]` | [`src/hooks/installer.mjs`](../src/hooks/README.md)의 `installCortex`·`uninstallCortex`를 그대로 부르는 래퍼입니다. 인자가 `install`도 `uninstall`도 아니면 사용법을 출력하고 종료 코드 1로 끝납니다. | Export 없음(불러오는 즉시 실행됨) |
| **`record-session.mjs`** | `node scripts/record-session.mjs <antigravity\|claude>` (표준 입력으로 훅 JSON) | [`src/revive/tracker.mjs`](../src/revive/README.md)의 `recordSession`을 부르는 래퍼입니다. 오류가 나도 항상 종료 코드 0으로 끝나며, `antigravity`일 때는 `{}`를 출력합니다. | Export 없음(불러오는 즉시 실행됨) |

---

## 설치와 제거

저장소 루트의 [`install.ps1`](../install.ps1)과 [`uninstall.ps1`](../uninstall.ps1)이 설치와 제거의 진입점입니다. 두 스크립트는 Node로 설치기 [`src/hooks/installer.mjs`](../src/hooks/README.md#설치기-installermjs)를 실행해 훅(에이전트가 세션 시작 같은 시점에 실행해 주는 외부 명령)·MCP 서버·스킬·전역 저장소를 다루고, PowerShell 실행 정책과 프로필은 이 폴더의 `install-tools.ps1`로 직접 다룹니다. 전역 저장소는 모든 프로젝트가 함께 쓰는 사용자 단위의 저장 폴더이며 기본 위치는 `%USERPROFILE%\.herdr-cortex\`입니다. 아래에서 `<전역 저장소>`로 줄여 씁니다.

### 요구 사항

- **Windows 11**과 PowerShell(Windows PowerShell 5.1 또는 PowerShell 7 이상). Windows 11 전용이며 다른 운영체제는 지원하지 않습니다.
- **Node.js 22.13.0 이상**. 내장 SQLite 모듈(`node:sqlite`)을 씁니다. `install.ps1`이 버전을 확인하고, 낮으면 아무것도 바꾸지 않고 끝납니다(종료 코드 1). `node`를 PATH에서 찾지 못했을 때도 같습니다.
- **Claude Code**(`claude`). Antigravity CLI(`agy`)는 있으면 함께 설정됩니다.
- **Herdr의 `hc.exe`**(선택). Herdr는 탭마다 에이전트를 띄우는 터미널 앱이고 `hc`는 그 명령줄 도구입니다. 탭 릴레이와 탭 복구에만 필요하며 PATH에 있어야 합니다. 없으면 설치 중 경고만 나옵니다.
- **`sqlite-vec` 패키지**(선택). 저장소 루트에서 실행하는 `npm install`은 벡터 검색에 쓰는 이 패키지 하나를 받습니다. 받지 않아도 설치는 되지만 경고가 나오고 벡터 검색은 꺼집니다.

### 설치: `install.ps1`

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

설치가 끝나면 **Claude Code와 Antigravity 탭을 다시 시작**하고, 기억을 쓸 프로젝트 폴더마다 `cortex-trust approve`를 한 번 실행합니다. 승인하기 전에는 그 폴더의 기억을 읽지도 쓰지도 않습니다([`src/core/README.md`](../src/core/README.md#3-프로젝트-승인-trustmjs-trust-climjs-confirmmjs)).

`install.ps1`은 바꿀 파일을 먼저 모두 읽어 검사합니다. JSON으로 읽을 수 없는 파일이 있거나, 구조가 예상과 다르거나, 이 도구의 것이 아닌 `herdr-cortex`라는 MCP 서버가 이미 등록되어 있으면 **아무것도 바꾸지 않고** 무엇이 문제인지 출력한 뒤 종료 코드 1로 끝납니다. 이때는 실행 정책과 프로필도 건드리지 않습니다.

기존 파일을 바꿀 때는 항상 먼저 `<파일>.herdr-cortex.<연월일-시분초>.bak`으로 복사합니다(예: `settings.json.herdr-cortex.20261123-141500.bak`). 같은 이름이 있으면 `-2`, `-3`을 붙이므로 백업끼리 덮어쓰지 않습니다. 내용이 달라지지 않는 파일은 다시 쓰지 않고 백업도 만들지 않습니다.

설치가 묻는 것과 바꾸는 것은 다음과 같습니다. 위의 다섯 줄은 Node 설치기가 하는 일이며 검사 항목, 적용 순서, 훅 명령의 형식은 [`src/hooks/README.md`](../src/hooks/README.md#설치기-installermjs)에 있습니다. 아래 두 줄은 `install.ps1`이 직접 합니다.

| 대상 | 하는 일 |
| :--- | :--- |
| **전역 저장소** `%USERPROFILE%\.herdr-cortex\` | `docs\`, `sessions\`, `config.json`을 만듭니다. `config.json`이 이미 있으면 그대로 두되, 이전 버전 설치기가 쓴 기본값과 완전히 같으면(임베딩 `auto`, 사용자가 고친 적 없음) 백업 후 현재 기본값(임베딩 꺼짐)으로 바꿉니다. 사용자가 고친 파일은 건드리지 않고 문제만 경고합니다. 설치에 쓴 Node 경로는 `state\install.json`에 기록합니다. |
| **Claude Code 훅** `~\.claude\settings.json` | `SessionStart`, `SessionEnd`, `PreCompact`, `UserPromptSubmit`, `PreToolUse`에 훅을 하나씩 추가합니다. 각 훅은 `command`에 **Node 실행 파일의 절대 경로**, `args`에 인자 목록을 적는 형식이어서 셸을 거치지 않고 실행되며 `node`가 PATH에 없어도 됩니다. 이 도구의 훅은 인자 끝의 `--id herdr-cortex`로 구분하고, 다시 설치하면 그 표시가 있는 훅만 바꿉니다. 사용자가 등록한 다른 훅은 그대로 둡니다. |
| **Claude Code MCP 서버** `~\.claude.json` | `claude` 명령을 찾으면 `claude mcp add --scope user --transport stdio herdr-cortex -- <node 경로> --no-warnings <저장소>\src\mcp\server.mjs`로 등록합니다. `claude`를 찾지 못했거나 그 명령이 실패하면 파일을 직접 고치고 그렇게 했다고 알립니다. 예전 이름 `cortex`로 등록된 항목은 이 도구의 것일 때만 지웁니다. 등록 뒤 1.5초를 기다렸다가 다시 읽어, 실행 중인 Claude Code가 파일을 덮어써 등록이 사라졌으면 경고합니다. |
| **Claude Code 스킬** `~\.claude\skills\cortex-*` | `prompts\skills\`의 스킬 5개를 `cortex-<이름>`으로 복사합니다. 이 도구가 만든 폴더(표시 파일 `.herdr-cortex-managed`가 있음)만 바꿉니다. |
| **Antigravity** `~\.gemini\` | `agy`가 PATH에 있거나 `~\.gemini` 폴더가 이미 있을 때만 건드립니다. `config\hooks.json`에 `SessionStart`와 `PreInvocation` 훅을, `antigravity-cli\mcp_config.json`에 MCP 서버를 등록합니다. `config\mcp_config.json`은 이미 있을 때만 갱신합니다. |
| **PowerShell 실행 정책** | 현재 정책으로는 프로필이 불러와지지 않을 때만 `Set the ExecutionPolicy of the current user to RemoteSigned? [Y/N]`이라고 **묻습니다**. 프로필이 불러와지지 않는 경우는 현재 사용자 범위의 정책이 `Restricted`일 때와, 현재 사용자 범위의 정책이 정해져 있지 않으면서(`Undefined`) 컴퓨터 범위의 정책도 정해져 있지 않거나 `Restricted`일 때입니다. `y`나 `yes`라고 답해야 현재 사용자 범위의 정책을 `RemoteSigned`로 바꾸고, 이전 값을 `<전역 저장소>\state\execution-policy.json`에 적어 둡니다. 물을 수 없는 환경(대화형 콘솔이 아님)에서는 바꾸지 않고 직접 실행할 명령(`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`)을 알려 줍니다. |
| **PowerShell 프로필** | `문서\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`에, PowerShell 7이 있으면(`문서\PowerShell` 폴더가 있거나 `pwsh`가 PATH에 있으면) `문서\PowerShell\Microsoft.PowerShell_profile.ps1`에도, 설치를 실행한 셸의 `$PROFILE`이 이 둘과 다르면 그 파일에도 `# >>> herdr-cortex >>>`와 `# <<< herdr-cortex <<<` 사이의 블록을 넣습니다. 블록은 `scripts\auto-revive.ps1`을 불러오는 한 줄입니다(`-NoAutoResume`로 설치하면 자동 복구를 끄는 한 줄이 앞에 더 들어갑니다). 파일의 원래 인코딩(UTF-8, UTF-16, 시스템 코드 페이지)을 감지해 그대로 읽고 쓰며, 블록 밖의 바이트는 바꾸지 않습니다. 그렇게 할 수 없는 파일이면 건드리지 않고 직접 넣을 줄을 보여 줍니다. 프로필이 없으면 새로 만듭니다. 인코딩 처리의 세부는 아래 [설치 보조 함수](#설치-보조-함수-install-toolsps1)에 있습니다. |

설치 끝에는 임베딩(문서를 숫자 벡터로 바꿔 뜻이 비슷한 문서를 찾게 하는 기능, 기본값은 꺼짐)이 지금 어디로 무엇을 보내는지 한 줄로 출력합니다. 기본값이면 "꺼져 있고 아무것도 보내지 않음"(`embedding: off (provider is "none"); nothing is sent anywhere.`)입니다.

`install.ps1`의 스위치는 네 개입니다.

| 스위치 | 뜻 |
| :--- | :--- |
| `-NoAutoResume` | 셸 명령은 설치하되, 셸이 시작될 때 탭을 자동으로 복구하지는 않습니다. |
| `-SetExecutionPolicy` | 실행 정책이 프로필을 막고 있으면 묻지 않고 `RemoteSigned`로 바꿉니다. |
| `-SkipExecutionPolicy` | 실행 정책을 묻지도 바꾸지도 않습니다. |
| `-NodePath <node.exe 전체 경로>` | `node`가 PATH에 없을 때 쓸 Node를 지정합니다. 이 경로가 훅과 MCP 등록에 기록됩니다. |

실행 정책을 바꾸지 않으면 프로필이 불러와지지 않으므로 아래의 셸 명령과 자동 탭 복구는 쓸 수 없습니다. 훅과 MCP 서버는 프로필과 무관하게 동작합니다.

Node를 다른 위치에 다시 설치하면 훅과 MCP 등록에 적힌 경로가 맞지 않게 됩니다. `cortex-status`가 이를 알려 주며, `install.ps1`을 다시 실행하면 고쳐집니다.

### 제거: `uninstall.ps1`

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

제거는 설치가 등록한 것만 지웁니다.

- `--id herdr-cortex` 표시가 있는 훅, 이 도구를 실행하는 MCP 항목, 표시 파일이 있는 스킬 폴더, 설치 기록을 지웁니다. 사용자의 다른 훅과 설정은 남습니다. Claude Code의 MCP 항목은 `claude`를 찾으면 `claude mcp remove`로 지웁니다.
- PowerShell 프로필에서 herdr-cortex 블록만 지웁니다(인코딩 유지, 백업 후).
- 설치가 실행 정책을 바꿨고 그 뒤로 값이 그대로이면 이전 값으로 되돌립니다. 그사이 다른 값으로 바뀌었으면 그대로 둡니다.
- 끝에 **남아 있는 것**을 출력합니다: 백업 파일 목록, 전역 저장소, 이전 도구(herdr-revive)의 저장소, 실행 정책 상태.

| 스위치 | 뜻 |
| :--- | :--- |
| `-RemoveBackups` | 이 도구가 만든 백업 파일(`<파일>.herdr-cortex.<날짜>.bak`과 이전 버전의 `<파일>.herdr-cortex.bak`)도 지웁니다. |
| `-PurgeData` | 전역 저장소 `%USERPROFILE%\.herdr-cortex\`(전역 기억 문서, 저장된 세션, 설정, 승인 목록, 받은편지함)와 이전 도구의 `%USERPROFILE%\.herdr-revive\` 폴더도 지웁니다. `-PurgeSessions`는 같은 뜻의 옛 이름입니다. |
| `-NodePath <경로>` | `node`가 PATH에 없을 때 쓸 Node를 지정합니다. 주지 않으면 PATH, 그다음 설치할 때 기록된 경로를 씁니다. |

각 프로젝트의 `.memory\` 폴더(그 프로젝트의 기억 문서가 들어 있는 폴더)는 사용자의 데이터이므로 어떤 스위치로도 지우지 않습니다. Node를 찾지 못하면 훅·MCP 항목·스킬은 지우지 못하고 그 사실을 경고합니다.

---

## 셸 명령

프로필이 불러와진 PowerShell 창에서는 어느 폴더에서나 아래 명령을 쓸 수 있습니다. 설치한 뒤 새 PowerShell 창을 열고 `cortex-status`를 실행하면 설치가 제대로 되었는지 확인할 수 있습니다.

| 명령 | 하는 일 |
| :--- | :--- |
| `cortex-status` | 설치 상태와 현재 폴더의 상태를 한 화면에 보여 줍니다(아래 "진단 항목"). |
| `cortex-worker` | 지시 파일을 읽어 `agy -p` 또는 `claude -p` 헤드리스 워커를 격리된 환경과 세션 한정 권한으로 실행합니다(아래 "`cortex-worker` 워커 실행"). |
| `cortex-trust approve [폴더]` | 그 폴더 하나를 승인합니다. 확인 대화상자가 먼저 뜨고 "예"를 눌러야 승인됩니다. |
| `cortex-trust revoke [폴더]` | 승인을 거둡니다. 대화상자는 뜨지 않습니다. |
| `cortex-trust status [폴더]` | 승인 여부를 보여 줍니다. 종료 코드는 승인됨 0, 승인 안 됨 1입니다. |
| `cortex-trust list` | 승인된 폴더를 모두 보여 줍니다. |
| `cortex-trust acknowledge` | 대화상자를 거치지 않고 바뀐 승인 목록을, 대화상자로 확인한 뒤 받아들입니다. |
| `revive-agents` | 빈 셸 상태인 탭을 모두 복구합니다. |
| `revive-agents -DryRun` | 아무것도 입력하지 않고, 탭마다 무엇을 할지와 건너뛰는 이유만 출력합니다. |
| `revive-status` | 살아 있는 탭과 탭별로 저장된 세션을 보여 줍니다(`revive-agents -Status`와 같음). |
| `revive-agy` | `revive-agents`와 같은 동작을 하는 다른 이름입니다. |

`cortex-trust`, `cortex-status`, `cortex-worker`는 `node`를 PATH에서 찾지 않습니다. 설치할 때 기록된 Node 경로(`<전역 저장소>\state\install.json`의 `nodePath`)가 있으면 그것으로 실행하고, 그 파일이 없거나 경로가 사라졌을 때만 PATH의 `node`를 씁니다. 둘 다 없으면 무엇이 없는지와 "Node.js 22.13 이상을 설치하고 `install.ps1`을 다시 실행하라"는 안내를 출력합니다.

`cortex-trust`에 폴더를 주지 않으면 이 셸의 현재 폴더가 대상입니다. 승인의 뜻과 대화상자의 동작은 [`src/core/README.md`](../src/core/README.md#3-프로젝트-승인-trustmjs-trust-climjs-confirmmjs)에 있습니다. 프로필 없이 쓰려면 `node <저장소>\src\core\trust-cli.mjs <명령> [폴더]`로 실행합니다.

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

### `cortex-worker` 워커 실행

HEAD 에이전트나 사용자가 구현·검수 작업을 다른 모델의 헤드리스 워커(`agy -p` 또는 `claude -p`)에게 맡길 때 씁니다. 프로필 없이 실행할 때는 `node --no-warnings <저장소>/scripts/cortex-worker.mjs ...`로 부릅니다.

```powershell
cortex-worker --role <developer|coder|reviewer> --agent <antigravity|claude> --model <모델 이름> --brief <지시 파일 경로> [--out <결과 파일 경로>] [--timeout <분>] [--allow <허용 규칙>]... [--cwd <폴더>]
```

- **환경 격리**: 자식 프로세스에 `HERDR_CORTEX_ROLE=worker`를 넣고 `HC_TERMINAL_ID`를 제거한 채 나머지 환경을 물려줍니다(워커의 훅이 HEAD 탭 세션 기록을 덮어쓰지 않음).
- **고정 프롬프트 전달**: 지시 파일 본문을 명령줄에 넣지 않고, 큰따옴표와 `%` 없이 역할 이름·`cortex_prompt(kind: 'agent', name: '<role>')` 로드·`<지시 파일 절대 경로>`·최종 메시지 반환만 적은 짧은 고정 문장을 전달합니다. 지시 파일이 없거나 비어 있으면 워커를 띄우지 않고 종료합니다. `claude` 호스트에서 지시 파일이 작업 폴더(`--cwd`) 밖에 있으면 `--add-dir`로 지시 파일의 부모 폴더를 추가하는데, 이는 지시 파일 하나가 아니라 **그 폴더 전체**를 워커가 읽을 수 있게 하므로 지시 파일은 민감하거나 무관한 파일이 섞이지 않은 전용 폴더에 두는 것을 권합니다.
- **세션 한정 권한**: 사용자 설정 파일은 읽지도 고치지도 않습니다. 기본으로 `herdr-cortex` MCP 도구만 허용하며(`antigravity`는 임시 설정 파일을 만들어 `--settings <임시 파일 경로>`로 넘기고 정상·오류·시간 초과 종료 시 삭제, `claude`는 `--allowedTools mcp__herdr-cortex__*`), 반복 가능한 `--allow <규칙>`을 그 호스트 표기 그대로 덧붙입니다. `-`로 시작하는 `--allow` 값과 줄바꿈이 든 `--model` 값은 인자 오류로 거부합니다.
- **시간 제한과 출력**: 기본 제한 시간은 40분(`--timeout 40`, `antigravity`에는 `--print-timeout`도 함께 전달)이며 초과 시 자식 프로세스 트리를 종료하고 0이 아닌 코드로 끝납니다. `cortex-worker` 자체가 강제 종료되거나 Ctrl+Break로 끊기면 워커 프로세스와 `antigravity`의 임시 설정 폴더(`%TEMP%\cortex-worker-*`, 허용 규칙만 들어 있음)가 남으므로 직접 끝내고 지워야 합니다. 워커의 표준 출력을 그대로 흘리고 `--out`이 있으면 UTF-8로 저장하며, 끝날 때 표준 오류에 한 줄 요약(`role`, `agent`, `model`, `elapsed`, `exit`)을 적습니다. 아무 출력 없이 끝나면 권한 거부 가능성을 표준 오류에 알리고 0이 아닌 코드로 종료합니다.
- **Windows 호스트 설치 형태와 셸별 주의 사항**:
  - PATH에서 호스트를 찾을 때 `.exe`·`.cmd`·`.bat`·`.ps1` 순서로 탐색합니다. `.exe`는 모든 인자를 그대로 전달합니다. `.cmd`·`.bat`은 `cmd.exe`를 거치므로 명령줄 인자(실행 파일 경로 포함)에 `%` 또는 줄바꿈(`\r`·`\n`)이 있으면 워커를 띄우기 전에 오류로 거부합니다. `.ps1`은 Windows PowerShell 5.1이 네이티브 실행 파일을 다시 호출할 때 큰따옴표를 지우고 끝 역슬래시 따옴표 경계를 깨뜨리므로, 명령줄 인자에 큰따옴표(`"`)나 공백과 함께 끝나는 역슬래시(`\`)가 있으면 워커를 띄우기 전에 오류로 거부합니다.
  - PowerShell 셸 함수 `cortex-worker`로 실행하면 Windows PowerShell 5.1이 `node.exe`로 인자를 넘기는 단계에서 인자 안의 큰따옴표(`"`)를 지우고, 공백이 있으면서 역슬래시로 끝나는 값(예: `--cwd '.\작업 폴더\'`)도 깨뜨립니다(오류로 끝남). 이런 값(예: `.exe` 호스트나 `antigravity`의 `--allow`)을 전달해야 할 때는 네이티브 호출자 또는 PowerShell 7.3 이상에서 `node --no-warnings <저장소>/scripts/cortex-worker.mjs ...`를 직접 실행하세요.
  - Git Bash(MSYS2)에서는 `/`로 시작하는 인자가 Windows 경로로 자동 변환되므로 그런 인자를 넘길 때는 `MSYS_NO_PATHCONV=1`을 앞에 붙여 실행합니다(예: `MSYS_NO_PATHCONV=1 node --no-warnings scripts/cortex-worker.mjs ...`).

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

전역 `config.json`(없으면 `~\.herdr-revive\config.json`)에 `claudeExtraArgs`나 `agyExtraArgs` 배열이 있으면, 위에서 만든 명령의 뒤에 그대로 덧붙입니다.

```json
{ "claudeExtraArgs": ["--dangerously-skip-permissions"], "agyExtraArgs": [] }
```

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
| `HC_TERMINAL_ID` | `auto-revive.ps1`, `cortex-status.mjs`, `cortex-worker.mjs` | Herdr가 탭마다 넣어 주는 탭 ID입니다. 자동 복구의 대상과 `cortex-status`가 보여 줄 받은편지함을 정하며, `cortex-worker.mjs`는 자식 워커를 띄울 때 이 변수를 제거합니다. |
| `HERDR_CORTEX_ROLE` | `cortex-worker.mjs` (설정) | `cortex-worker.mjs`가 자식 프로세스에 `worker`로 넣어 헤드리스 워커 세션임을 알립니다. |
| `HERDR_REVIVE_DISABLE` | `auto-revive.ps1` | `1`이면 자동 복구만 끕니다. 셸 명령은 그대로 쓸 수 있습니다. |
| `HERDR_REVIVE_IN_AGENT` | `auto-revive.ps1` | 자동 복구가 에이전트를 실행하는 동안 `1`로 두어, 그 안에서 열린 셸이 다시 복구를 시도하지 않게 합니다. |
| `CLAUDECODE` | `auto-revive.ps1` | 값이 있으면 Claude Code가 띄운 셸로 보고 자동 복구를 하지 않습니다. |
| `HERDR_CORTEX_HOME` | `store-location.ps1` | 전역 저장소 폴더를 직접 지정합니다. |
| `HERDR_CORTEX_TEST_HOME`, `HERDR_REVIVE_TEST_HOME` | `store-location.ps1`, `install.ps1`, `uninstall.ps1` | 홈 폴더를 다른 폴더로 바꿉니다(테스트용). 이 값이 있으면 설치·제거는 실제 실행 정책과 실제 `$PROFILE`을 읽지도 바꾸지도 않습니다. |
| `HERDR_CORTEX_TEST_EXECUTION_POLICY` | `install-tools.ps1` | 테스트 홈에서 쓸 가짜 실행 정책(`<CurrentUser>,<LocalMachine>`)입니다. 테스트 홈이 아니면 무시합니다. |

홈 폴더는 `HERDR_CORTEX_TEST_HOME`, `HERDR_REVIVE_TEST_HOME`, `USERPROFILE` 순으로 정하고, 전역 저장소는 `HERDR_CORTEX_HOME`, 그다음 `<홈 폴더>\.herdr-cortex` 순으로 정합니다.

---

## 한계

**탭 복구**

- `revive-agents`가 실제 Herdr 탭에 명령을 입력하는 동작은 자동 테스트에서 가짜 `hc`로만 실행했습니다. 처음에는 `revive-agents -DryRun`으로 계획을 확인하세요. 재부팅 뒤의 자동 복구는 실제 탭에서 확인했습니다(아래 [확인 상태](#확인-상태)).
- 탭을 닫아도 그 탭의 세션 기록(`sessions\<탭 ID>.json`)은 지워지지 않습니다. 세션 ID로 하는 복구는 같은 세션 ID가 다른 탭의 기록에도 있는지 확인하지 않으므로, 한 대화를 두 탭에서 연 적이 있으면 두 기록에 같은 세션 ID가 남고, 나중에 두 탭이 모두 빈 셸로 열리면 둘 다 같은 대화를 엽니다. 쓰지 않는 탭의 기록은 `revive-status`로 확인한 뒤 그 파일을 직접 지웁니다.
- `revive-agents`는 빈 셸의 종류를 가리지 않고 명령을 입력합니다. 폴더 이동이 필요한 경우에만 PowerShell인지 확인합니다.
- `hc send`가 실패한 탭(`[FAILED]`)에는 아무것도 입력되지 않았으므로 그 탭에서 직접 명령을 실행해야 합니다.
- 탭 복구는 폴더가 같은지를 경로 문자열로 비교하므로, 같은 폴더를 정션으로 연 탭은 다른 폴더로 봅니다.
- 탭 제목으로 추측하는 복구(`-c`)는 그 폴더의 가장 최근 대화를 여는 것이어서, 그 탭에서 하던 대화가 아닐 수 있습니다.

**설치**

- Windows 11 전용입니다.
- Node 설치 위치가 바뀌면 `install.ps1`을 다시 실행해야 합니다(`cortex-status`가 알려 줍니다).
- Claude Code가 실행 중일 때 설치하면 MCP 등록이 덮어써져 사라질 수 있습니다. 설치기가 이를 확인해 경고하며, 그때는 Claude Code 창을 모두 닫고 다시 설치합니다.
- 실행 정책을 바꾸지 않으면 셸 명령과 자동 탭 복구를 쓸 수 없습니다.

---

## 확인 상태

자동 테스트는 가짜 `hc`, 격리된 홈 폴더, 흉내 낸 실행 정책을 씁니다([`test/README.md`](../test/README.md#실물과-대역)). 이 폴더의 스크립트에 대해 실제 환경에서 직접 본 것과 그렇지 못한 것을 구분해 적습니다. 아래의 "개발 PC"는 Windows 11, Node 26.13.1, `hc` 0.1.21, Claude Code 2.1.330이 설치된 한 대이며, 이 PC에 `install.ps1`로 실제 설치해 보았습니다. 다른 모듈의 항목까지 모은 목록은 [루트 README](../README.md#확인-상태와-알려진-한계)에 있습니다.

### 실제로 확인한 것

- **실행 정책 변경과 프로필**: `install.ps1 -SetExecutionPolicy`가 현재 사용자의 정책을 `Undefined`에서 `RemoteSigned`로 바꾸고 이전 값을 기록했으며, 새로 만든 프로필이 새 PowerShell 창에서 불러와져 `cortex-status`, `cortex-trust`, `revive-agents`가 잡혔습니다. 이 설치에서 알게 된 것이 하나 있습니다. `powershell -ExecutionPolicy Bypass -File install.ps1`로 실행하면 `Set-ExecutionPolicy`가 값을 저장한 뒤에도 "더 구체적인 범위가 이 값을 덮어쓴다"는 보안 오류를 던집니다. 그래서 설치기는 오류 여부가 아니라 저장된 값을 다시 읽어 성공을 판정합니다(`Invoke-HerdrPolicyChange`).
- **재부팅 뒤 자동 복구**: 개발 PC를 재부팅한 뒤 Herdr가 Claude Code 탭 두 개를 PowerShell 빈 셸로 다시 열었고, 두 탭 모두 사람의 입력 없이 `claude --resume <세션 ID>`로 원래 대화를 이어 열었습니다. 실행된 세션 ID는 각 탭의 세션 기록에 저장돼 있던 값과 같았고, `claude`를 띄운 것은 그 탭의 PowerShell 프로세스였으며(셸이 시작된 지 1초 뒤), PowerShell 입력 기록에는 재부팅 뒤에 입력된 명령이 없었습니다. 두 탭은 세션 기록이 있고 기록된 폴더와 같은 폴더에서 열린 경우였습니다. 기록만 있고 탭이 없는 세션은 열리지 않았습니다. 폴더를 옮긴 뒤 여는 경우, 탭 제목으로 추측하는 `-c` 복구, Antigravity 탭은 이 확인에 들어 있지 않습니다.

### 확인하지 못한 것

항목마다 무엇을 확인하지 못했는지, 왜 못 했는지, 지금 무엇을 근거로 삼고 있는지, 어떻게 확인하면 되는지, 가정이 틀렸을 때 어떤 증상이 나오는지를 적었습니다.

#### 실행 정책을 묻는 화면, 제거할 때의 복원, 이미 있는 프로필에 대한 동작

| | |
| :--- | :--- |
| **무엇을** | `install.ps1`이 실제 콘솔에서 `[Y/N]`으로 실행 정책을 묻는 모습, `uninstall.ps1`이 실제 정책을 기록해 둔 이전 값으로 되돌리는 것, 내용이 이미 들어 있는 실제 `$PROFILE` 파일에 블록을 넣고 빼는 것 |
| **왜 못 했나** | 실제 설치는 `-SetExecutionPolicy` 스위치로 묻는 단계를 건너뛰었고, 프로필 파일이 없던 PC라 새로 만드는 경우만 지나갔으며, 제거는 실행하지 않았습니다. |
| **지금의 근거** | 실제 설치에서 정책 변경과 이전 값 기록, 새 프로필 생성과 불러오기는 확인했습니다. 묻는 화면과 복원, 여러 인코딩의 기존 프로필은 격리된 테스트 홈에서의 실행과 바이트 단위 자동 테스트가 근거입니다. |
| **확인 방법** | 스위치 없이 설치해 화면을 보고, 제거한 뒤 `Get-ExecutionPolicy -Scope CurrentUser`가 설치 전 값인지, 프로필 파일이 블록만 빠진 원래 내용인지, 옆에 백업 파일이 있는지 확인합니다. |
| **틀렸을 때 증상** | 복원이 안 되면 제거한 뒤에도 정책이 `RemoteSigned`로 남습니다(`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Undefined`로 직접 되돌릴 수 있습니다). 기존 프로필 처리가 틀리면 설치기는 그 프로필을 건드리지 않고 사유를 출력하도록 되어 있으며, 어떤 경우에도 날짜가 붙은 백업이 먼저 만들어집니다. |

#### `revive-agents`의 실제 실행, `hc send`로 탭을 실제로 깨우는 것

| | |
| :--- | :--- |
| **무엇을** | 자동 복구 가운데 폴더를 옮긴 뒤 여는 경우와 탭 제목으로 추측하는 `-c` 복구, `revive-agents`가 실제 탭에 명령을 입력하는 것, `relay_send`(다른 탭으로 메시지를 보내는 MCP 도구, [`src/relay/README.md`](../src/relay/README.md))가 쉬고 있는 실제 탭을 깨우는 것 |
| **왜 못 했나** | `revive-agents`와 `relay_send`는 사용 중인 터미널에 글자가 입력되는 동작이라 가짜 `hc`로만 실행했습니다. 실제 재부팅 때는 세션 기록이 있고 폴더가 같은 탭만 있었습니다. |
| **지금의 근거** | 재부팅 뒤 자동 복구가 세션 기록대로 동작한 실제 확인(위의 "실제로 확인한 것"), 실제 `hc ls`·`hc get` 출력 모양을 그대로 쓴 자동 테스트, 그리고 판정 결과를 확인하는 `-DryRun` |
| **확인 방법** | `revive-agents -DryRun`으로 계획을 먼저 보고, 탭 하나에서 실제로 실행해 봅니다. 릴레이는 쉬고 있는 탭 하나에 `relay_send`를 보내 봅니다. |
| **틀렸을 때 증상** | 탭이 복구되지 않거나 명령이 다른 모습으로 입력됩니다. `hc send`가 실패하면 `[FAILED]`로 표시되고 그 탭에는 아무것도 입력되지 않습니다. |

---

## 관련 테스트

- [`test/powershell-scripts.test.mjs`](../test/powershell-scripts.test.mjs): 프로필 블록의 인코딩 보존과 백업, `revive-agents`와 자동 복구의 판정, 셸 명령이 기록된 Node 경로로 실행되는지, 테스트 홈에서의 `install.ps1`·`uninstall.ps1`
- [`test/powershell-store-location.test.mjs`](../test/powershell-store-location.test.mjs): PowerShell 스크립트와 Node 쪽이 같은 전역 저장소 위치를 고르는지
- [`test/cortex-status.test.mjs`](../test/cortex-status.test.mjs): `collectStatus`·`formatStatus`
- [`test/cortex-worker.test.mjs`](../test/cortex-worker.test.mjs): `cortex-worker.mjs`와 PowerShell `cortex-worker` 명령(환경 격리, 호스트별 인자 조립, `.cmd`·`.ps1`·`.exe` 실행, `--out`, 시간 초과, 무출력 감지, 인자·지시 파일 검증)
- [`test/trust-confirm.test.mjs`](../test/trust-confirm.test.mjs): 승인 목록 변경이 `cortex-status`에 표시되는지
- [`test/hooks-and-budget.test.mjs`](../test/hooks-and-budget.test.mjs), [`test/installer.test.mjs`](../test/installer.test.mjs): 이전 도구가 등록한 `record-session.mjs` 훅을 알아보는지

전체 목록과 개수는 [`test/README.md`](../test/README.md)에 있습니다.
