# dsh-simple-notify

DSH 桌面端通知：一轮对话停下来等你的时候，右下角弹一个 Windows 系统气泡。

**只对你自己有用，不发布。** 仓库放在 `E:\deepseek-harness\default-workspace\dsh-simple-notify`，
通过 junction 挂进 profile：`<DSH_HOME>\profiles\<profile>\node_modules\dsh-simple-notify`。

---

## 它能做什么

| 事件 | 行为 |
|---|---|
| 一轮对话结束（`agent/turn-stopping`） | 弹气泡，标题「任务完成」，正文是会话名 |
| 模型提问等你回答（`user-questions/request`） | 弹气泡，标题「在等你回答 · 会话名」，正文是问题 |
| 子 agent 的通知 | **默认不弹** |
| DSH 窗口在前台 | **默认不弹** |
| 自检发现问题 | 弹气泡，**无视前台规则**（看不见的错误更糟） |
| **点气泡** | **把 DSH 窗口叫到前台**（两种气泡都支持） |

## 点击气泡回到 DSH

点系统气泡的「打开 DSH」按钮，或点自绘气泡本身，会把 DSH 窗口恢复并切到前台。

实现分两半：

- **系统气泡**：toast XML 里放一个 `<action activationType="protocol" arguments="dsh://open">`。
  点击交给 Windows 激活 `dsh:` 协议，命中的是正在运行的 DSH 单实例处理器
  （`claimDesktopSingleInstance` → `focusPrimaryWindow`），效果就是窗口恢复 + 置顶 + 抢焦点。
- **自绘气泡**：点一下先关掉自己，再用 Win32 `AttachThreadInput` + `SetForegroundWindow`
  把窗口进程叫到前台。必须先关自己，否则那块 topmost 面板会盖住刚叫到前面的 DSH。

**注意这只能定位到「DSH 窗口」，不能定位到某个具体会话。** 桌面外壳没有会话级深链
（`protocol.handle` 只认 `dsh://shell` 和 `dsh://app`，`DESKTOP_IPC` 里没有任何「打开会话」通道）。
要做到「点通知直达某条会话」，得给插件补一个浏览器端半边去调 `ctx.uiWorkspace.openSession()`，
是另一个量级的改动。

自绘气泡点击后的结果写进日志（`click focus: focused` / `set-foreground refused` /
`no main window (window is hidden to tray)`），失败不会静默。

## 换电脑怎么搬

1. 把整个 `dsh-simple-notify` 目录复制到新机器上任意位置（例如 `<工作区>\dsh-simple-notify`）。
2. 在 `<DSH_HOME>\profiles\<profile>\node_modules\` 下建一个 junction 指过去：

   ```powershell
   New-Item -ItemType Junction `
     -Path   "$env:DSH_HOME\profiles\desktop\node_modules\dsh-simple-notify" `
     -Target "<新机器上的插件目录>"
   ```

3. 确认 profile 的 `package.json` 里有这两处：

   ```json
   "dependencies": { "dsh-simple-notify": "*" },
   "dsh": { "profile": { "bundles": [ "...", "dsh-simple-notify" ] } }
   ```

4. 重启 DSH。启动后看 `lib/turn-notify.log`，应出现 `listener registered`。

**不需要改任何代码。** 路径全部由环境变量或插件自身位置推导：

| 用途 | 解析顺序 |
|---|---|
| profile 目录 | `config.profileDir` → `DSH_PROFILE_DIR` → `<DSH_HOME>/profiles/<DSH_PROFILE>` → 插件目录的上级的上级 |

## 这台机器上的一个坑：AUMID

Windows 的 Toast **只能由已注册 AppUserModelId 的应用发出**。注册方式是在开始菜单里有一个
带 `System.AppUserModel.ID` 属性的快捷方式。

本机的注册情况（实测）：

```
C:\Users\30499\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk
  AppUserModel.ID = com.deepseek.dsh
```

**这个属性是 DSH 安装程序写进去的，不是插件写的。** 新机器装完 DSH 通常会再写一次；
如果没有，气泡会**静默不显示**（Windows 不报错）。

检查方法：

```powershell
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk"
$shell = New-Object -ComObject Shell.Application
$d = $lnk.Substring(0, $lnk.LastIndexOf('\'))
$n = $lnk.Substring($lnk.LastIndexOf('\') + 1)
$shell.Namespace($d).ParseName($n).ExtendedProperty('System.AppUserModel.ID')
```

## 配置项

在 profile 的 `cordis.patch.yml` 里覆盖（`id: simple-notify`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `title` | `任务完成` | 轮次结束气泡的标题 |
| `suppressWhenForeground` | `true` | 前台不弹 |
| `showSubagents` | `false` | 子 agent 也弹 |
| `showQuestions` | `true` | 提问时弹 |
| `aumid` | `com.deepseek.dsh` | 换版 DSH 后 AUMID 变了要改这里 |
| `appProcessNames` | `["DeepSeek Harness"]` | 判定「前台」用的进程名；DSH 改名后要改 |
| `powershellPath` | 环境变量 `DSH_NOTIFY_POWERSHELL` 或 `powershell.exe` | |
| `clickToFocus` | `true` | 点气泡把 DSH 叫到前台。设 `false` 则气泡不可点，行为回到旧版 |
| `enabled` | `true` | 设 `false` 关闭整个插件 |

## 自检

每天第一次加载时跑一次，结果写进 `lib/turn-notify.log`，有问题会弹气泡。检查五项：

1. profile 的 junction 能解析
2. 插件自己的文件齐
3. `package.json` 有 `exports`（缺了加载器会静默跳过）
4. profile 的 `bundles` 和 `dependencies` 里还有它
5. **AUMID 是否已注册**——读开始菜单快捷方式的 `System.AppUserModel.ID`，
   和插件发送用的 `aumid` 比对。缺失/为空/不匹配都会报出来。

第 5 项**只报告，不修改任何系统设置**。确认缺失后按上面的命令自己补快捷方式。

日志里正常时会有一行：

```
self-check: AUMID "com.deepseek.dsh" is registered by C:\...\DeepSeek Harness.lnk
```

换电脑后没看到这行，就说明气泡不会显示。

## 依赖的平台事实

- **Windows 专用**（`package.json` 里 `os: ["win32"]`），气泡靠 WinRT `ToastNotificationManager`
- **PowerShell 5.1 起**。不需要 `pwsh`
- `.ps1` 文件必须是**纯 ASCII**：PowerShell 5.1 用 ANSI 代码页读脚本，中文字面量会乱码。
  所以中文全部以 Base64(UTF-8) 通过环境变量传入，脚本里只做解码

### 踩过的坑（改这几个文件前先看）

1. **`Add-Type` 编译的 C# 里不能写任何 PowerShell 语法**。我把 `Get-Variable`/`Write-Output`
   写进了 `OnClick`，编译报 `应输入 ;`。
2. **C# 类里不能调用 PowerShell 函数**。跨语言只能用委托：PowerShell 把 scriptblock 转成
   `[Func[int,string]]`，C# 存成字段，点击时调用。这样 Win32 的聚焦逻辑只写一份（在 `notify.ps1`）。
3. **`Add-Type` 会缓存类型**，同一个会话里重复定义同名类会报「类型已存在」。
4. 窗口跑在 `Application.Run` 的消息循环里，事件处理器中拿到的异常要拆 `InnerException` 才有用。

