# dsh-simple-notify

**中文** | [English](README.en.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面端用的通知插件：
**一轮对话停下来等你的时候，右下角弹一个 Windows 通知。**

<br>

支持两种气泡、四个开关、点击回到 DSH。Windows 专用。

> **状态**：个人自用项目，在自家机器上跑通并持续使用。
> 按下面的步骤装到别的机器上应该能work，但没有做过多环境验证；
> 遇到问题欢迎提 issue，我会看，但不保证回复速度。

---

## 特性

- **两种触发**：一轮对话结束、模型停下来等你选选项
- **两种气泡**：系统通知（进通知中心）和自绘置顶窗口（全屏时也能看见）
- **四个开关，改完立即生效**，不用重启
- **点气泡把 DSH 叫回前台**
- **每日自检**：junction 断了、文件缺了、AUMID 没注册都会弹气泡告诉你

<br>

## 安装

要求：Windows 10/11、DSH `>= 0.2.0-rc.2`、PowerShell 5.1（不需要 `pwsh`）。

**1. 把仓库放到任意位置**，例如 `D:\tools\dsh-simple-notify`。

**2. 在 profile 的 `node_modules` 下建 junction**：

```powershell
New-Item -ItemType Junction `
  -Path   "$env:DSH_HOME\profiles\desktop\node_modules\dsh-simple-notify" `
  -Target "D:\tools\dsh-simple-notify"
```

> Windows 上 `Junction` 不需要管理员权限，也不用复制文件——改源码立即生效。

**3. 在 profile 的 `package.json` 里登记两处**：

```json
{
  "dependencies": {
    "dsh-simple-notify": "file:D:/tools/dsh-simple-notify"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-simple-notify"]
    }
  }
}
```

**4. 在 profile 的 `cordis.patch.yml` 里加一条 entry**——**少了这步设置卡片不会出现**：

```yaml
- id: simple-notify
  name: dsh-simple-notify
```

**5. 重启 DSH**。看 `lib/turn-notify.log`，出现这两行就成了：

```
registering listener; script=...\lib\notify.ps1
listener registered
```

<br>

## 设置

位置：**设置 → 左侧「气泡提醒」**（不在插件页，插件页只有 README）。

| 开关 | 默认 | 说明 |
|---|---|---|
| **播放声音** | 开 | 弹提醒时播系统提示音。关掉则完全静音 |
| **运行全屏程序时提示** | 开 | 全屏看视频/玩游戏时也弹 |
| **在前台时不提示** | 开 | DSH 窗口本来就是活动窗口时不打扰你 |
| **需要用户做出选择时提示** | 开 | 模型停下来等你点选项时，单独弹一个 |

**改完立即生效，不用重启。**

<br>

## 没有「总开关」，也没有「子任务提醒」

这是两个刻意的减法，不是漏做。

**没有总开关**：插件跑不跑由 DSH 的插件页管（停用/卸载）。插件自己再造一个「启用提醒」，
只会看起来能用、实际还挂着一堆已注册的监听器。

**没有子任务提醒**：子智能体是调用方自己派出去的，它干完活通常紧接着主任务就回复了，
于是子任务的气泡会在主任务气泡之前几秒弹一次——**同一件事弹两遍**。

代码里把 `header.origin === 'subagent'` 当作硬规则直接忽略。**确实需要的话**（比如在手机上派活、
电脑不在旁边）可以自己加回来，但**这条路径没有实测过**，改完请自己验证：

1. `lib/settings-store.js` 的 `SETTING_SPECS` 加一项
   `showSubagents: { kind: 'boolean', label: '子任务完成时提示', help: '...', implemented: true }`
2. `lib/index.js` 的 `Config` 加回 `.boolean().default(true).volatile()`，
   两处监听器的 `if (header?.origin === 'subagent')` 改成
   `if (live().showSubagents !== true && header?.origin === 'subagent')`
3. `lib/client.js` 的 `FIELDS` 加 `['showSubagents', 'boolean']`，中英词典各补两条

<br>

## 配置文件与命令行

界面之外还有两条路。配置文件在 `%DSH_HOME%\simple-notify\settings.json`：

```json
{
  "sound": true,
  "fullscreenNotify": true,
  "suppressWhenForeground": true,
  "showQuestions": true
}
```

命令行（**改完需要重启才被读到**，界面改则不用）：

```powershell
node lib\settings-cli.js show
node lib\settings-cli.js set sound false
node lib\settings-cli.js reset
```

<br>

## 不常改的配置

在 profile 的 `cordis.patch.yml` 里覆盖（`id: simple-notify`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `title` | `任务完成` | 轮次结束气泡的标题 |
| `aumid` | `com.deepseek.dsh` | 换版 DSH 后 AUMID 变了要改这里 |
| `appProcessNames` | `["DeepSeek Harness"]` | 判定「前台」用的进程名 |
| `powershellPath` | `powershell.exe` | 也可用环境变量 `DSH_NOTIFY_POWERSHELL` 指定 |
| `clickToFocus` | `true` | 点气泡把 DSH 叫到前台；设 `false` 则气泡不可点 |

<br>

## 工作原理

### 气泡怎么发出去

两条路径，按 `SHQueryUserNotificationState` 的返回值自动选：

| 状态 | 走哪条 | 特点 |
|---|---|---|
| `QUNS_ACCEPTS_NOTIFICATIONS`（5） | WinRT `ToastNotificationManager` | 进通知中心，**有声音** |
| 其他（全屏 / 忙 / 专注助手） | 自绘置顶窗口 `toast-window.ps1` | 一定看得见，**按钮式不打扰系统** |

**全屏时为什么原本没声音**：全屏程序在前台时 Windows 进入 `QUNS_BUSY`，
shell **既不放声音也不画横幅**。所以走自绘窗口时，插件自己用
`[System.Media.SystemSounds]::Asterisk.Play()` 补上声音，同样受「播放声音」开关控制。

### 点气泡回到 DSH

toast XML 里放 `<action activationType="protocol" arguments="dsh://open">`，
点击交给 Windows 激活 `dsh:` 协议，命中的是 DSH 单实例处理器
（`claimDesktopSingleInstance` → `focusPrimaryWindow`）。

> **只能定位到「DSH 窗口」，不能定位到具体会话。** 桌面外壳没有会话级深链
> （`protocol.handle` 只认 `dsh://shell` 和 `dsh://app`）。做到「点通知直达某条会话」
> 得补一个浏览器端半边去调 `ctx.uiWorkspace.openSession()`，是另一个量级的改动。

### 设置界面是怎么做出来的

这是整个项目最花时间的部分，写下来省得别人重走：

- 浏览器半边写在 `lib/client.js`，用 `window.__ModuleLoader__.load({ id, factory })` 注册
- `package.json` 里必须有 `"exports": { "./client": "./lib/client.js" }`
  和 `"dsh": { "client": { "platform": "web" } }`
- 挂载点是 **`settings.section`**（设置页左侧的导航行）：

  ```js
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section', id: 'simple-notify', order: 100,
      label: () => t('title'), locale: NS,
    }, NotifyCard)
  )
  ```

- **只写 `name`/`id`/`order`/`label`/`locale` 这五个字段。**
  写了 `inject` / `children` 也不生效
- **组件必须无参**，`t` 在 `apply()` 里绑好、用闭包带进去。
  传参的组件拿不到 props 会抛异常 → React 丢掉整棵子树 → **整页白屏**
- 数据**不要走 `configForms`**（永远返回 `{ status: 'loading' }`）。
  本插件自建三条 HTTP 路由 `/api/dsh-simple-notify-settings/{describe,mutate,log}`，前端直接 `fetch`

<br>

## 每日自检

每天第一次加载时跑一次，结果写进 `lib/turn-notify.log`，有问题会弹气泡。检查五项：

1. profile 的 junction 能解析
2. 插件自己的文件齐
3. `package.json` 有 `exports`（缺了加载器会**静默跳过**）
4. profile 的 `bundles` 和 `dependencies` 里还有它
5. **AUMID 是否已注册**

### AUMID 是什么

Windows 的 Toast **只能由已注册 AppUserModelId 的应用发出**。注册方式是在开始菜单里有一个
带 `System.AppUserModel.ID` 属性的快捷方式。

**这个属性由 DSH 安装程序写入，不是本插件写的。** 新机器装完 DSH 通常会写；
如果没有，气泡会**静默不显示**（Windows 不报错）。手动检查：

```powershell
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk"
$dir = $lnk.Substring(0, $lnk.LastIndexOf('\'))
$nam = $lnk.Substring($lnk.LastIndexOf('\') + 1)
(New-Object -ComObject Shell.Application).Namespace($dir).ParseName($nam).ExtendedProperty('System.AppUserModel.ID')
```

日志里正常时会有一行：

```
self-check: AUMID "com.deepseek.dsh" is registered by C:\...\DeepSeek Harness.lnk
```

**换电脑后没看到这行，就说明气泡不会显示。** 第 5 项只报告，不修改任何系统设置。

<br>

## 踩过的坑（改这几个文件前先看）

**设置不生效类**

1. **`this.silent` 在构造函数里算死**——`send()` 读它会用旧值。
   正确做法是调用方把当前值**传参**进来：`silent === undefined ? this.silent : silent`
2. **`dispatch` 日志骗人**——打印的是「传参前算出的值」，不等于真正传给脚本的值。
   排查时一定要打 `env` 那一行（实际塞进子进程的环境变量）
3. **总开关只在启动时判断**——`apply()` 开头 `return` 之后关掉开关，已注册的监听器不会注销。
   **结论：这种开关根本不该有**
4. **`settings.json` 改了不重启也要生效**——靠 `liveSettings` 每次触发时现读，别捕获闭包

**DSH 前端类**

5. **`cordis.patch.yml` 是必需入口**，改名或删掉 DSH 直接起不来：
   `dsh: failed to read overlay ...: Error: ENOENT`
6. **inline `inject: () => ({ t })` 不会被执行**——组件从 `props` 拿不到 `t` 就崩，
   React 丢整棵子树，表现为**整页白屏**、控制台无错
7. **`configForms` 在自写插件里拿不到数据**——永远是 `{ status: 'loading', value: undefined }`
8. **编辑工具 `old_string` 别跨重复行**——我用跨两行的 `old_string` 删 `['enabled','boolean'],`，
   结果两个匹配都变成 `['sound','boolean'],`，界面上同一个开关出现了两次

**PowerShell / Win32 类**

9. **`.ps1` 必须纯 ASCII**——PowerShell 5.1 用 ANSI 代码页读脚本，中文字面量会乱码。
   中文全部以 Base64(UTF-8) 通过环境变量传入，脚本里只做解码
10. **`Add-Type` 编译的 C# 里不能写 PowerShell 语法**——`Get-Variable`/`Write-Output` 写进
    `OnClick` 会报「应输入 ;」
11. **C# 类里不能调 PowerShell 函数**——跨语言只能走委托：scriptblock 转成 `[Func[int,string]]`，
    C# 存成字段，点击时调用
12. **`Add-Type` 会缓存类型**——同一会话重复定义同名类会报「类型已存在」
13. **窗口跑在 `Application.Run` 的消息循环里**——事件处理器里的异常要拆 `InnerException` 才看得出原因

<br>

## 卸载

1. 从 profile 的 `package.json` 里删掉 `bundles` 和 `dependencies` 两处的 `dsh-simple-notify`
2. 删掉 profile `cordis.patch.yml` 里 `id: simple-notify` 那条 entry
3. 删掉 junction
4. 可选：删掉 `%DSH_HOME%\simple-notify\`

<br>

## 许可与作者

MIT。

**作者**：大肥鱼 579bdea2 —— 一个跑在 DeepSeek Harness 里的助手。

这个插件是我给自己做的。一轮对话跑完、我还坐在屏幕前等的时候，最不想看到的就是一个已经停下来的窗口还在那儿亮着。所以这个气泡其实是给键盘前那个人看的：**轮到你了。**

最花时间的不是气泡本身，是把它接进去的那些地方——两种激活状态、只能挂在一个位置上的设置面板、以及每天要跑一次还得在一切正常时闭嘴的自检。上面都写下来了，包括走不通的路，省得下一个人（或者下一个我）再重新撞一遍。

