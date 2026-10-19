# OpenCode V2 兼容修复交付记录

本地修复版：0.22.0（包含 0.21.1 的 V2 兼容修复及后续 beige 主题）。基线：bmpenuelas/opencode-web-sidebar main，commit `83d45c5`（0.21.0）。日期：2026-10-19。

## 仓库和环境

任务目录起初没有源码，也不是可用 Git 仓库；保留原目录内容，将指定项目检出到 `/home/gfy/software/opencode-sidebar/source`。检出后工作区干净。主分支已有新版 UI 的项目登记脚本；`origin/dev` 落后，没有本任务所需路由处理。未提交、推送或修改已安装插件，也未修改 OpenCode 程序、原数据库或配置。依赖沿用 package-lock，无新增项目依赖。

本机已安装插件为 0.21.0。找到的现有 CLI 是 2.0.32；为精确测试，按官方安装脚本提供的 npm 包 `@opencode/cli-linux-x64@2.0.31` 下载独立二进制到 `/tmp/oc-toolchain/v2.0.31/package/bin/opencode`，以独立 XDG 数据目录、随机认证密码及动态端口启动。测试服务 API 报告 2.0.31，随该二进制附带的网页页脚报告 2.0.30；两者均为实际观测值。

## 根因及证据

1. `src/WorkspaceNavigation.ts:getWorkspaceSessionPath` 原先无条件生成 `/<base64url(directory)>/session`。其原意是通过旧 UI 的项目直达入口打开当前工作区的新会话。`src/OpenCodeProjectBootstrap.ts` 原有兼容补丁只登记项目，仍依赖网页自行转换旧入口。
2. [OpenCode v2.0.31 的实际路由](https://github.com/anomalyco/opencode/blob/v2.0.31/packages/app/src/shell/routes/routes.tsx) 已没有这个兼容入口。[currentRoute](https://github.com/anomalyco/opencode/blob/v2.0.31/packages/app/src/shell/state/layout.tsx) 对它明确抛出 `Unrecognised route!`。真实 Chromium 复现：代理首页及旧路由均 HTTP 200，但只有旧路由出现该异常。错误详情在只读 textarea 中，验证读取了其 value。
3. `OpenCodePanel.ts:prepareWorkspaceLaunch` 原先清空保存地址；`computeUIState` 在工作区启动未完成时优先使用旧入口。失败路由无法完成启动，因此刷新、重新创建 Webview 会反复使用错误入口。原地址只保存在内存中，未按服务器/工作区持久化。
4. `startProxy` 原先用 4 秒截止时间包裹 `asExternalUri`，超时后仍保留 `_proxyPort`；其他入口以“有端口”判断就绪，从而可能使用未完成转发的回环地址。Promise.race 不取消原异步调用，迟到的解析日志也不代表 `_proxyBaseUrl` 已赋值。
5. 现场宿主网络只读探测：49374 的 `/global/health` 返回 **200 text/html**；`/api/info` 返回 **401 application/json**。因此原“no auth / health 200”不能证明 V2 API 认证正常。首次沙箱内探测不可达只是网络隔离，后续宿主网络探测已纠正。现有服务未做认证读取和写入测试。

服务端口和插件代理端口不同是原设计，未将代理端口改成服务端口。

## 修改内容

- `WorkspaceNavigation.ts`：保留旧版入口；新增 V2 首页启动参数、路由校验，以及基于 Base64URL 服务器键的精确地址重绑定。目录通过 URLSearchParams 传输，空格和 UTF-8 不丢失。
- `OpenCodeProjectBootstrap.ts`：V2 在官方应用模块执行前登记项目，并按 2.0.31 的真实 [DraftTab/SessionTab schema](https://github.com/anomalyco/opencode/blob/v2.0.31/packages/app/src/shell/tabs/schema.ts) 追加所需条目，保留其他条目和草稿内容；随后 history.replaceState 进入受支持路由。该适配复用项目原有注入架构，不替换官方应用。没有稳定的工作区直达路由，因此依赖已核实的 V2 网页持久化协议；未来若该协议变化需要重新验证。存储异常时回到首页。
- `OpenCodePanel.ts`：通过携带原有认证的 `/api/info` JSON 检测 V2；V2 使用该 API 检查健康，旧版继续原健康检查。按服务器 ID、配置 URL、工作区保存相对地址；本代理服务器键先保存为后端标识，恢复时绑定当前转发地址。ocFrameUrlChanged 校验 iframe 来源和 origin。有效消息结束启动状态，刷新和重新创建视图不会清空会话。未知路由、损坏存储、API 确认已删除的会话回退首页。断开状态提供 Retry。
- 代理连接：URI 解析最多 15 秒，完整连接检查最多 30 秒；相同目标并发启动合并，切换目标重新启动；明确区分监听端口和转发就绪；失败清理代理，操作标识隔离过期结果及切换服务器后的状态更新。没有新增无限等待/无限重试；原可配置自动重连策略保留。
- `ProxyServer.ts`：增加 V2 启动脚本，升级共享代理功能键 v6 → v8（v7 为 V2 启动脚本，v8 为 beige 主题注入），避免新版本复用旧进程的注入脚本。主题只注入 CSS 变量与 data 属性脚本，不修改 OpenCode 代码、路由或存储。HTTP/SSE/WebSocket、动态端口分配、认证注入及代理管理架构保留。
- 新增面板状态测试、扩展导航/注入测试、主题模块测试，添加可选真实浏览器脚本。package.json/package-lock 将本地包版本设为 0.22.0；无依赖升级。

## 路由变化

以用户提供的工作区作为验证用例，产品源码没有硬编码此路径或端口：

```text
旧：/<base64url(workspace)>/session
V2 首次请求：/?_ocWorkspace=<URLSearchParams 编码的当前目录>
V2 应用启动前：/new-session?draftId=<实际登记的草稿 ID>
已有会话：/server/<base64url(当前代理 origin)>/session/<实际 session ID>
恢复请求：/?_ocWorkspace=...&_ocRestore=<保存并重新绑定后的地址>
失效路由：/
```

启动参数是插件内部交接参数，会在官方应用启动前移除；不是猜测出的官方工作区路由。健康检查不会把 HTTP 200 的 HTML 当作 V2 API 成功。

## 验证范围

真实浏览器：Ubuntu，Chromium 141，独立 OpenCode **2.0.31**，真实目录 **`/home/gfy/software/Traffic monitor`**，真实认证代理，动态服务及代理端口。未发送模型请求。代理测试数据位于独立临时目录。

| 场景 | 已执行结果 | 验证层次 |
| --- | --- | --- |
| 服务可连接、首次首页 | 通过；认证代理可加载官方网页 | 真实浏览器 |
| 旧式入口 | 成功复现 Unrecognised route!；HTTP 仍为 200 | 真实浏览器 |
| 当前工作区包含空格 | 通过；草稿目录精确匹配实际目录 | 真实浏览器 |
| 新草稿、刷新草稿 | 通过；草稿 ID 和目录保留 | 真实浏览器 |
| 创建聊天会话 | 真实 API 创建两个隔离会话并渲染通过 | 真实 API + 浏览器 |
| 切换已有会话 | 官方可见桌面标签栏点击 A/B，URL 正确切换 | 真实浏览器 |
| 刷新、关闭重开 | 保留会话；没有旧路由异常 | 真实浏览器 + 面板状态测试 |
| 代理端口变化 | 占用旧端口强制分配新端口；空浏览器存储恢复同一会话 | 真实代理 + 浏览器 |
| iframe 嵌入 | 使用插件原始 HTML/CSP/sandbox，模拟 acquireVsCodeApi 消息桥；内容、地址回传和外层刷新通过 | 真实 Chromium，模拟 VS Code host API |
| beige 主题（浅色首帧、暖深色热切换、native 还原、携带主题参数的草稿启动） | 通过真实代理断言 html 属性与 `--v2-*` 计算值；native 恢复官方 `#fafafa`；草稿登记仍通过 | 真实代理 + Chromium（`scripts/verify-theme.cjs`，5 项通过） |
| 转发超过原 4 秒 | 4.5 秒异步完成可连接；并发启动合并 | 面板自动化模拟 |
| URI 超时、迟到结果、途中切换服务器 | 失败清理，迟到结果不覆盖后续连接 | 面板自动化模拟 |
| 失效地址/已删除会话 | 首页回退；刷新保持首页 | 自动化模拟 |
| 服务不可用/认证缺失 | 明确断开与 Retry；401 显示认证状态 | 自动化模拟 + 现场只读 HTTP 探测 |
| Windows VS Code + Remote SSH 实际转发 | **尚未执行** | 需要用户安装包后验收 |
| 真实 VS Code 侧边栏内的主题渲染（含 Remote SSH） | **尚未执行**：仅完成 Chromium 模拟与计算色值断言 | 需要用户安装包后验收 |
| 正式模型发送、Agent 工具调用及流式回复 | **尚未执行** | 测试未读取用户凭据或调用付费模型 |
| 其他旧版 OpenCode 服务端实际联调 | **尚未执行**；原分支及旧版测试保留 | 源码/回归测试 |

`npm test` 包含编译、lint、30 项 Node 回归测试（V2 导航/注入 23 项、主题 7 项）。lint 为 0 error、58 项风格 warning（包含原有及新增代码的单行 if 风格）；不为本任务全库格式化。真实浏览器证据见仓库外 `../artifacts/`，避免将测试数据库/密钥打包。

## 构建和安装

在有 Node.js 22 和 npm 的终端：

```bash
cd /home/gfy/software/opencode-sidebar/source
npm ci
npm test
npx vsce package --out ../opencode-sidebar-0.22.0-ryjs.vsix
```

真实浏览器验证可选（Playwright 单独安装，不增加插件依赖）：

```bash
OPENCODE_BINARY=/path/to/opencode-2.0.31 \
PLAYWRIGHT_MODULE=/path/to/playwright \
TEST_WORKSPACE='/home/gfy/software/Traffic monitor' \
node scripts/verify-v2.cjs

OPENCODE_BINARY=/path/to/opencode-2.0.31 \
PLAYWRIGHT_MODULE=/path/to/playwright \
node scripts/verify-theme.cjs
```

脚本启动自己的服务并创建临时数据库，退出时关闭自己的进程和代理。TEST_WORKSPACE 省略时自动创建临时含空格目录。模型请求不会发送。

在 Windows VS Code 中先连接 Remote SSH Ubuntu，再打开 Extensions 面板的菜单 **Install from VSIX…**，选择本地下载的 VSIX，并确认安装在 **SSH: Ubuntu**。也可在该 Remote SSH 窗口的远程集成终端运行：

```bash
code --install-extension /home/gfy/software/opencode-sidebar/opencode-sidebar-0.22.0-ryjs.vsix --force
```

随后执行 **Developer: Reload Window**。确认 SSH 端扩展版本为 0.22.0，再打开 **OpenCode: Focus Panel**。保留已有服务器配置，服务 URL 仍为 `http://localhost:49374`（以当前实际服务为准）；代理端口由插件自动处理。不要把服务地址填成代理端口。插件 ID 变为 `ryjs.opencode-web-sidebar`，设置命名空间不变；首次需重新输入一次服务器密码（SecretStorage 按扩展 ID 隔离）。

现场 `/api/info` 目前为 401。如果插件还未保存服务器密码，执行 **OpenCode: Set Server Password**，使用该 OpenCode 服务的认证信息；凭据仍由原 SecretStorage 管理。浏览器已有的配对登录不会自动迁移到插件代理 origin。无需手工填写工作区网页路由，也无需清除网页存储或原会话。

安装后在真实 Remote SSH 窗口完成：进入工作区、发送一条正常 Agent 对话、切换会话、隐藏再打开、刷新，并检查 Output → OpenCode Sidebar 的 V2 检测及最终 iframe 地址。应看到 V2 草稿/会话路径，不应再进入旧式工作区 `/session` 地址。此步骤尚未由本次执行环境操作，不能报告为已通过。
