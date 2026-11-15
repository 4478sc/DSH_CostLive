# 主机→VM 同步链：无窗口启动与自愈（2026-11-16）

本文记录 CostLive 主机→VM 同步链的无窗口化改造：**根因、仓库内实现、计划任务接法、回滚、回归测试与实测证据**。
文中的 `<repo>` 指 DSH_CostLive 仓库，`<dsh-cost>` 指宿主上该部署自己的推送目录
（`config/vm-dashboard.local.json` 的 `pushLoop` 所在目录，可以不在仓库内）。

## 1. 现象与根因

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 每隔一个 tick 弹出可见 Terminal 窗口 | 计划任务动作直接运行 `powershell.exe -WindowStyle Hidden`：控制台照样被创建，Windows Terminal 作为默认终端时把它显示成窗口 | 任务动作改为 `wscript.exe //nologo //B tools\launch-hidden.vbs <script>`（GUI 宿主，无控制台）；脚本内部再起控制台子进程一律走 `tools\hidden-launch.ps1` 的 CREATE_NO_WINDOW |
| 每个 tick / 每次 SSH 失败都新起一个 push-loop | `Start-Process -WindowStyle Hidden` 无条件启动，离线时 supervisor 约 13–14 秒一圈，每圈都拉一次 | 启动前用命名 mutex 探测（`Test-ProcessMutex`），已在运行就不启动 |
| VM 离线时高频重试 | 转发循环固定 5 秒重试，push-loop 固定 20/60 秒 | 离线指数退避 5→10→20→40→60 秒封顶，健康运行 ≥60 秒后重置；退避序列由 `Get-NextRetryDelay` 计算，可被测试重放 |
| 多个入口重复保活 | 每 5 分钟任务、每 10 分钟任务、登录任务各自拉起 push-loop | 三个任务统一指向唯一入口 `tools\ensure-host-sync.ps1` → `tools\vm-dashboard.ps1 -Ensure` → supervisor → uploader；**任务本身全部保留**，只改动作 |

## 2. 修复后的调用链

```text
计划任务（5 分钟 / 10 分钟 / 登录）
  └─ wscript.exe //nologo //B <repo>\tools\launch-hidden.vbs <repo>\tools\ensure-host-sync.ps1
       └─ powershell.exe -File ensure-host-sync.ps1            （隐藏控制台，窗口样式 0）
            └─ Start-HiddenPowerShell → vm-dashboard.ps1 -Ensure （CREATE_NO_WINDOW）
                 ├─ Test-ProcessMutex DSH_CostLive_VmPushLoop → 未持有才启动 uploader
                 └─ Test-ProcessMutex DSH_CostLive_VmDashboard → 未持有才启动 supervisor
                      └─ vm-dashboard.ps1（常驻）
                           ├─ 每圈先探测 uploader mutex，缺失才补
                           ├─ Start-HiddenProcess ssh.exe -N -L ... （CREATE_NO_WINDOW）
                           │    失败退避 5/10/20/40/60 秒；连续在线 ≥60 秒重置
                           └─ uploader: <dsh-cost>\vm\push-loop.ps1（mutex DSH_CostLive_VmPushLoop）
                                └─ Start-HiddenPowerShell → push-to-vm.ps1 -LogPath state\push.log
                                     离线(exit 3)退避 5/10/20/40/60 秒；成功(exit 0)重置为 20 秒
```

不要再把任务动作写成 `powershell.exe -WindowStyle Hidden -File ...`，也不要在脚本里用
`Start-Process powershell.exe ... -WindowStyle Hidden`：两种写法都会创建控制台，实测都会出现可见窗口。

## 3. 仓库内的实现

| 文件 | 作用 |
| --- | --- |
| `tools/hidden-launch.ps1`（新增） | `New-HiddenStartInfo`（UseShellExecute=false + CreateNoWindow）、`Start-HiddenProcess`、`Start-HiddenPowerShell`、`ConvertTo-NativeArgument`（含空格/引号路径的参数引号化）、`Test-ProcessMutex`、`Get-NextRetryDelay` |
| `tools/launch-hidden.vbs`（新增） | 任务级无控制台宿主：`WScript.Shell.Run(cmd, 0, False)`；无参数时打印用法并退出 2 |
| `tools/vm-dashboard.ps1` | `-Ensure` 与 supervisor 循环改为“先探测 mutex 再启动”；SSH 转发与两个子进程全部 CREATE_NO_WINDOW；新增 `out/vm-dashboard.log` 与退避；helper 从**仓库内** `tools/hidden-launch.ps1` 加载 |
| `tools/ensure-host-sync.ps1` | VM 分支改走 `Start-HiddenPowerShell -Wait`，helper 同样来自仓库；缺失时报错退出，不回退到窗口方式 |
| `test/host-sync.tests.ps1`（新增） | 启动器、参数引号化、单实例 mutex、退避序列、错误文案的回归测试 |

关键点：**仓库不再依赖部署方本机额外新增的外置文件**。早先的修复把 `hidden-launch.ps1` 放在
`<dsh-cost>\vm\`（与 `push-loop.ps1` 同目录），仓库脚本再去那里加载；现在 helper 随仓库发布，
`tools/vm-dashboard.ps1` 与 `tools/ensure-host-sync.ps1` 都只看 `tools/` 下的这一份。
外置 `<dsh-cost>\vm\` 仍保留自己的 `hidden-launch.ps1`，因为 `push-loop.ps1` / `push-to-vm.ps1`
是部署方自己的推送脚本、不在本仓库内。

## 4. 计划任务

三个任务保留原触发器、运行账号与 `MultipleInstances=IgnoreNew`，只把动作换成 wscript 入口：

| 任务 | 触发器 | 动作 |
| --- | --- | --- |
| `DSH_CostLive_SyncKeepAlive` | 每 5 分钟 | wscript → `launch-hidden.vbs` → `ensure-host-sync.ps1` |
| `DSH_CostLive_VmPush_KeepAlive` | 每 10 分钟 | 同上（原先直接跑 push-loop） |
| `DSH_CostLive_VmPush` | 登录时 | 同上（原先直接跑 push-loop） |

- 三个任务都在，**没有删除任何任务**；统一入口只是为了不再重复拉起 uploader。
- `<Hidden>` 仍是 false：它只影响任务计划程序 UI 的显示，对窗口没有作用，不要依赖它。
- 笔记本部署还要把 `DisallowStartIfOnBatteries` / `StopIfGoingOnBatteries` 设为 false，
  否则电池供电时自愈 tick 会被整段跳过。

注册示例（`<repo>` 换成实际路径；注意 cmd 里成对的双引号）：

```bat
schtasks /Create /TN DSH_CostLive_SyncKeepAlive /SC MINUTE /MO 5 /F ^
  /TR "wscript.exe //nologo //B ""<repo>\tools\launch-hidden.vbs"" ""<repo>\tools\ensure-host-sync.ps1"""
```

## 5. 部署与回滚

部署（先备份任务 XML 与脚本副本，再动手）：

1. 停掉旧的 supervisor / uploader（按精确 PID `Stop-Process`，不要模糊匹配进程名）。
2. 用 `schtasks /Create /TN <name> /XML <file> /F` 把三个任务的 `<Actions>` 换成上面的 wscript 动作。
3. 手动 `schtasks /Run /TN DSH_CostLive_SyncKeepAlive` 或直接运行 `ensure-host-sync.ps1` 拉起新链。
4. 校验：supervisor 与 uploader 各 1 个进程、两个 mutex 均为 True、下一个 tick 没有新的可见窗口。

回滚：用备份的脚本副本覆盖 `tools/`，再用备份的任务 XML `schtasks /Create /F` 覆盖三个任务，
然后重启链路。回滚后可见窗口问题会一并回来（那是改前状态，不是新问题）。

## 6. 回归测试

```powershell
npm run test:ps          # 需要 Windows + Windows PowerShell（或 pwsh）
```

| 用例 | 断言 |
| --- | --- |
| 模块加载 | `hidden-launch.ps1` 可 dot-source，六个函数都在 |
| 参数引号化 | 空串、普通串、含空格、含 `"`、空格+结尾反斜杠都按 CreateProcess 规则引用（平台无关，可在非 Windows 上单独跑） |
| 无窗口启动 | `New-HiddenStartInfo` 返回 `UseShellExecute=false`、`CreateNoWindow=true` |
| 退出码与空格路径 | 含空格目录下的探针脚本经 `Start-HiddenPowerShell -Wait` 启动，参数原样到达，退出码 7 透传 |
| 单实例 | `Test-ProcessMutex` 在 mutex 不存在时为 False，持有期间为 True，持有者退出后回到 False |
| 退避 | `Get-NextRetryDelay` 重放 5/10/20/40/60/60，超过上限封顶，健康后从 Start 重新开始 |
| VBS 入口 | 无参数时 `cscript //nologo launch-hidden.vbs` 退出 2；带空格参数时被启动的脚本确实执行并收到参数 |
| 错误文案 | `ensure-host-sync.ps1` 在 helper 缺失时报 `Missing windowless launcher helper: ...`，不静默退回窗口方式 |

窗口是否真的不出现属于桌面会话观察项，不能在没有交互桌面的 CI 里断言；测试锁定的是导致窗口的启动方式
（GUI 宿主 + CREATE_NO_WINDOW），A/B 实测见下一节。

## 7. 实测证据（2026-11-16）

- A/B 对照（同一台机、同一会话）：`Start-Process powershell -WindowStyle Hidden` 新增可见窗口 2 个
  （`CASCADIA_HOSTING_WINDOW_CLASS`、`PseudoConsoleWindow`）；`Start-HiddenProcess`（CreateNoWindow）
  新增可见窗口 0 个，退出码 7 正常透传。
- 修复前：计划任务 tick 后约 1 秒出现 `CASCADIA_HOSTING_WINDOW_CLASS` 可见窗口（标题 `Windows Terminal`）。
- 修复后：覆盖 2 个 5 分钟 tick + 1 个 10 分钟 tick，新可见窗口 0 个。
- 退避：`out/vm-dashboard.log` 记录 `ssh forward exited code=255 after 8s; retry in 5s / 10s / 20s / 40s`；
  离线期间 `state/push.log` 每 60 秒封顶一条 offline。
- 单实例与自愈：`-Ensure` 后 supervisor / uploader 仍各 1 个；手工再跑 push-loop 立即 exit 0 且不重复；
  杀掉 uploader 后 supervisor 6 秒内补回；杀掉 supervisor 后下一个 tick 0.5 秒内补回，uploader pid 未变。
- 真实同步（VM 在线后）：`state/push-loop.heartbeat` `exit=0 next=20s`，`state/push.json` 的
  `lastPushAt` 持续推进，`push.log` 连续出现 `ip=<vm-ip> ref=... sessions=2/2 ... token=unchanged` 行，
  宿主 `127.0.0.1:4173` 与 VM `<vm-ip>:4173` 返回同一个实例的 `/api/health`（`generatedAt` 相同）。

## 8. 限制与未覆盖

- 本改造只覆盖 VM 推送链。仓库里旧的“主机侧拉取 VM 日志”模式（`tools/start-sync.ps1`、
  `dsh-cost-vm-sync.cmd`）本来就会开一个同步控制台窗口，本次没有改变它。
- `<dsh-cost>\vm\push-loop.ps1`、`push-to-vm.ps1`、`ensure.sh` 属于部署方文件，不在本仓库内，
  所以本仓库不重写它们；它们的退避与日志格式见各自的部署记录。
- 未修改默认终端设置，未停用/删除计划任务，未改 VM 配置，未改 DSH 插件。
