# 认证持久化专项修复记录

检查日期：2026-10-20（用户时区 Asia/Shanghai）。源码目录为 `/home/gfy/software/opencode-sidebar/source`。

## 工作区与边界

修改前 `git status --porcelain=v1` 为空，基线提交为 `b1897e151d88629a0d0f731c2968a850572b93b9`。外层目录不是 Git 仓库。未修改主题实现、OpenCode 主程序、用户服务配置、既有端口配置或用户会话。版本仍为 `0.22.3`，publisher 仍为 `ryjs`。未打包、提交、推送或安装变更。

## 已证实的插件问题

1. 旧 `/global/health` 逻辑先无认证探测，再认证重试；认证请求超时会返回 `auth-required`，认证重试返回 5xx 也可能沿用首次 401。网络故障因此被错报为需要登录。现在 V2 `/api/info` 与旧健康接口使用同一凭据构造，401/403、网络失败、其他非成功状态分别处理；失败不删除凭据。
2. V2 `/api/info` 原有 401 分支直接返回 `auth-required`，不能区分首次登录与已保存凭据被拒绝，也缺少提前的过期请求检查。现在记录 HTTP 状态及凭据是否存在，并区分首次登录、已拒绝和本地恢复失败；切换服务器后的过期响应被丢弃。
3. 代理直接使用 `URL.username/password` 构造 Basic Header，URL 编码后的特殊字符没有解码；另外 URL 属性赋值不会完整编码字面 `%`。健康检查直接用原密码时可能成功，而代理失败。现在在构建目标 URL 时显式编码，在代理边界解码一次，HTTP 与 WebSocket 共用该认证值。
4. `_passwordsCache` 原本只在没有该 ID 时读取 SecretStorage，空结果也永久缓存，未订阅 SecretStorage 变化。现在配置重载会重新读取，并响应 SecretStorage 变更；本地读取失败保留已有数据、阻止错误转发，并允许重试。
5. 原用户名保存在 settings，密码保存在 SecretStorage，两次独立更新及其配置事件可能交错；登录方法还跨 await 重新读取活动服务器 ID。现在按稳定 ID 保存包含用户名、密码、origin 的单条 SecretStorage 记录，输入前捕获 ID/URL，保存前复核目标，成功写入后才更新内存及报告已保存。用户名不再依赖另一次 settings 更新。
6. 原配置重查在已有代理就绪时可能复用旧目标/旧凭据。现在比较目标与凭据，匹配才复用；发生变化才重新建立代理。共享代理特性键更新，避免连接其他窗口中的旧实现；端口范围不变。
7. 旧迁移可能覆盖已有 per-server 密码，且失败后也标记已完成。现在串行迁移，仅在新旧 per-server 记录均不存在时导入旧密码；失败可重试，保留旧数据。旧 per-server 密码首次恢复时绑定 origin，原键继续保留。

原来的 `saveServerPassword()` **已经 await SecretStorage.store()**，并非完全没有保存或总是提前报告成功。原实现也没有在普通健康失败时主动删除密码。发现的是状态误判、缓存不刷新、用户名/密码非原子关联、服务器选择竞态及编码不一致，不能据此断言此次事故发生过本地凭据删除。

## 当前凭据策略

- 主记录：`opencode-web-sidebar.server.<id>.credentials`，内容为 `{ username, password, origin }`，仅存于 SecretStorage。
- 兼容读取原 `.password` 与 settings username；不批量清空旧认证数据。
- 相同记录不重复写入；同服务器的 SecretStorage 读写串行。
- 新凭据先向目标验证。错误令牌、临时断网或存储失败不会覆盖原记录。空表单密码不会删除已有密码；只有原有显式清除命令清除认证。
- 主记录格式损坏、origin 不匹配、重复/空服务器 ID 作为本地恢复/关联错误处理，不伪装成“没有保存密码”。配置 ID 改名不会猜测迁移到另一个 ID。
- 保留已有环境密码回退，同时识别 V2 的 `OPENCODE_PASSWORD` 和兼容变量 `OPENCODE_SERVER_PASSWORD`；环境值不自动覆盖已保存凭据。
- 重新认证不重设保存的 iframe 路径、会话或工作区；代理换端口后继续使用已有导航恢复机制。

## OpenCode V2 实证

本机安装版本为 `opencode v2.0.32`。已检查安装二进制内随包 JavaScript 认证、配对与服务配置实现，并以该二进制启动独立服务验证，没有套用旧版文档。

二进制 SHA-256：`489b51816a77809e841310e80c88e834c28c19ad1639e12ba8a19f08b47ab607`。

- 固定 Basic 用户名为 `opencode`；密码可以是服务器密码，也可以是有效会话令牌。该实现未把 Bearer Token 当作此认证入口。
- `POST /api/pair` 要求认证，返回 `{ code, expires_in }`；一次性码有效期为 300 秒，存放在当前服务实例的配对缓存。
- `GET /auth/connect/:code` 携带 `Accept: application/json` 返回 `{ token }`；再次兑换同码得到 401。浏览器 HTML 请求走 cookie 和跳转分支，插件使用 JSON 分支。
- 会话令牌有效期为 2,592,000 秒（30 天）。令牌包含到期秒数与 HMAC，签名依赖服务器密码；签名用途字符串为 `opencode-session-v1`。服务器验证时间及签名，没有在这些处理函数中发现自动刷新会话令牌的接口。
- 服务端密码变化会使已有令牌签名失效。真实隔离服务验证：相同密码重启仍接受旧令牌；变更密码后拒绝旧令牌。**不能把普通服务重启一概说成令牌轮换**：后台 service 的首次随机密码会写入服务配置，后续会读取它。
- 浏览器 cookie 使用同类会话令牌，因此到期或服务端密码变化可同时影响官方网页和插件。这是已验证的失效条件，**不是对此次历史事故触发原因的认定**：没有读取用户真实令牌、服务密码或历史日志，无法判断当时是到期、密码变化还是其他服务端变化。
- 没有为了延长登录修改服务器安全配置、密码或令牌有效期。

官方仓库的 [配对目标问题记录](https://github.com/anomalyco/opencode/issues/53710) 也记录了 `pair --url` 可能仅改变链接地址、而配对码仍在本地共享服务上创建的行为。本次实现要求链接与插件配置的 origin 严格一致，不自动尝试其他服务，也不自动调用该参数或修改服务配置。

## 配对入口

认证界面增加“通过配对链接登录”，原用户名/密码入口保留。用户执行 `opencode pair` 后粘贴新的链接，插件验证协议、精确 origin 和 `/auth/connect/<code>` 路径，禁止 userinfo、query、fragment 和 HTTP 跳转。`localhost` 与 `127.0.0.1` 不自动等同，不同端口不等同。

兑换、认证验证和 SecretStorage 保存依次完成，之后重连代理并保留会话导航。过期、已使用、目标不符或网络失败会保留旧凭据。配对码可能在保存失败前已经被兑换；这种情况需要生成新链接，不能重复兑换旧链接。

## 诊断

OpenCode Sidebar 输出通道记录服务器 ID、连接 origin、SecretStorage 恢复存在/缺失/失败、保存完成/失败、健康 HTTP 状态、认证状态、代理是否提供认证与状态转换。

不记录密码、令牌、Authorization、完整配对链接或带认证信息的 URL。fetch/代理异常只记录错误类型，原始服务 stdout/stderr 和完整启动命令不再原样写入通道，因为实际 V2 启动输出可能含密码。登录错误提示分别说明服务端拒绝、服务不可用、目标改变与本地保存失败。

## 验证

编译通过。49 项源码测试全部通过：Authentication 6、OpenCodePanel 15、WorkspaceNavigation 10、OpenCodeProjectBootstrap 7、SidebarTheme 11。ESLint 0 errors、56 warnings（现有单行控制语句风格告警）；双语运行时文案 72 项、配置 NLS 38 项及 `git diff --check` 通过。

新增 `src/Authentication.test.ts`，扩展 `src/OpenCodePanel.test.ts`；`package.json` 测试脚本包含认证测试。`scripts/verify-auth-live.cjs` 是显式运行的真实 V2 隔离接口检查，不放入默认无环境单元测试。

环境没有 PATH 中的 npm/node，使用 VS Code Server 自带 Node v24.21.0 运行本地 TypeScript、ESLint 与测试；未安装依赖或修改系统环境。可复测方式：

```bash
# 在 source/，正常 Node/npm 环境中
npm test
npm run verify:l10n
npm run verify:nls
OPENCODE_AUTH_TEST_BINARY=/home/gfy/.opencode/bin/opencode node scripts/verify-auth-live.cjs
```

真实脚本使用 `/tmp` 独立 XDG 数据/配置目录、随机测试密码与临时服务端口，真实代理状态也写入临时目录。结束时关闭服务并清理测试目录。它验证：

- 实际 V2 版本、未认证 401、特殊字符 Basic 密码 200。
- 配对码 300 秒 TTL、JSON 兑换、单次使用、会话 30 天 TTL、错误令牌 401。
- 实际代理附加并覆盖 Authorization，特殊字符可用，代理换端口后继续认证。
- 用隔离服务密钥签发的短时有效令牌到期前 200、到期后 401；没有等待实际 30 天。
- 服务停止时连接不可用、持久化记录保留；同密码重启旧令牌 200、换密码旧令牌 401。

现有用户服务 `http://localhost:49374/api/info` 只做无认证只读探测，返回 401；未尝试获取或替换其凭据。真实接口测试均针对隔离服务，**不能替代 Windows VS Code + Remote SSH 验收**。

| 验收项目 | 已完成证据 | 尚需真实用户环境验证 |
| --- | --- | --- |
| 1. 首次登录 | Mock 保存等待/验证；真实 Basic 和配对兑换 | VS Code 登录界面操作 |
| 2. 关闭并重开侧边栏 | Mock 执行 close，创建新 panel 从共享 SecretStorage 恢复，路径保留 | 实际 Webview 关闭重开 |
| 3. Reload Window | 新 panel/新存储实例恢复契约测试 | 实际扩展宿主重启及系统密钥环 |
| 4. Remote SSH 断开重连 | 新实例恢复和代理重建测试 | Windows 到 Ubuntu 的真实 SSH 重连 |
| 5. 主题切换 | Mock 调用真实 onThemeChanged，凭据/路径/代理不变，既有主题测试通过 | 实际主题切换 |
| 6. 代理端口变化 | Mock 及真实代理强制换端口后认证 200 | VS Code 转发与 Webview 实际表现 |
| 7. 临时断网 | Mock 超时/5xx；真实服务停止时保留记录，恢复后认证 | 实际网络波动后的 UI 自动恢复 |
| 8. 错误令牌 | Mock 验证拒绝、不覆盖旧凭据；真实 401 | 实际提示文案 |
| 9. 服务端失效 | Mock 明确拒绝与本地异常分开；真实令牌到期/密钥变更 401 | 生产服务实际失效事件的端到端显示 |
| 10. 重认证保留会话/工作区 | Mock 原路径及工作区保留，既有导航测试通过 | 实际会话自动续接 |

完整脱敏结果保存在外层 `artifacts/auth-regression-tests.log` 和 `artifacts/auth-live-tests.log`。

## 是否需要重新认证

本次只修改源码，没有部署或修改现有用户认证数据，当前环境无需因本次修复重新登录。验收部署后现有同 ID、同地址的凭据可兼容恢复；只有服务端拒绝、令牌到期，或本地记录与目标地址不符且用户选择重新绑定时，才需要新的登录/配对操作。30 天服务器令牌到期必须尊重，插件不会用旧缓存绕过。

## 修改文件清单

- `src/OpenCodePanel.ts`、`src/ProxyServer.ts`、`src/extension.ts`
- 新增 `src/Authentication.ts`、`src/Authentication.test.ts`
- 扩展 `src/OpenCodePanel.test.ts`
- 新增 `scripts/verify-auth-live.cjs`
- `package.json` 仅调整测试脚本，没有提升版本号
- `l10n/bundle.l10n.json`、`l10n/bundle.l10n.zh-cn.json` 仅调整认证文案
- 本记录 `docs/authentication-audit.md`
