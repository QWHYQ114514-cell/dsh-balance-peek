# dsh-balance-peek

在 DeepSeek Harness 侧边栏底部，用两行极简文字显示 **DeepSeek 余额**、**当日花费** 和 **当前峰谷时段**。

```
余额                    ¥14.31
今日    ¥0.17                  谷价
```

- **极简**：纯文字，没有图标、没有图表、没有动画。宽栏两行；收起成 56px 窄栏时退化为「余额 / 谷」两格。
- **实时**：余额每分钟自动刷新；峰/谷状态与倒计时由浏览器本地时钟每秒计算，不产生任何额外请求。
- **零配置**：直接复用 DSH 已保存的 `DEEPSEEK_API_KEY`；没配 key 时退回已登录的 DeepSeek 账号钱包。
- **点击展开**：点这两行会强制刷新余额，并展开当日明细（请求次数、token 数、今日充值次数、余额更新时间）。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile desktop add github:QWHYQ114514-celle/dsh-balance-peek

# 从 npm 安装（发布后可用）
dsh plugin --profile desktop add dsh-balance-peek

# 从本地目录安装
dsh plugin --profile desktop add link:/path/to/dsh-balance-peek
```

把 `desktop` 换成你自己的 profile 名（Web 版通常是 `web`）。装好后刷新页面即可看到。

> **只加依赖是不够的。** DSH 通过 profile 的 `dsh.profile.bundles` 决定挂载哪些插件；本包在 `package.json` 里声明了 `dsh.bundle.patch`，所以只要它在 bundles 列表里就会被挂载。`dsh plugin add` 会自动把它加进去；如果你手工编辑过 `package.json`，请确认列表里有 `dsh-balance-peek`。

卸载：

```sh
dsh plugin --profile desktop remove dsh-balance-peek
```

## 峰谷规则

按 DeepSeek 官方定价页（[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)）：

| 时段 | 判定 |
| --- | --- |
| 高峰 | 北京时间**周一至周五**（不含中国法定节假日）**9:00–12:00、14:00–18:00** |
| 空闲 | 其余全部时段，含**周末**、**调休上班的周末**、**法定节假日全天** |

高峰单价 = 空闲单价 × 2。计费只用官方价目表：

| 模型 | 缓存命中（空闲/高峰） | 缓存未命中（空闲/高峰） | 输出（空闲/高峰） |
| --- | --- | --- | --- |
| `deepseek-flash`（含旧名 `deepseek-v4-flash`） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

> ⚠️ **年度维护**：法定节假日清单写在 `lib/index.js` 与 `lib/client.js` 的 `HOLIDAY_VALLEY` 常量里，目前覆盖 **2026 年**。国务院每年 11 月发布次年安排后需要补录，否则次年的法定节假日会被当成普通工作日显示（只影响显示，不影响计费）。

## 数据来源与口径

- **余额**：调用官方 `https://api.deepseek.com/user/balance`，凭据来自 DSH 的 `credentials` 服务；取不到 key 时退回 `deepseekAccount.getBalance()`（登录账号的钱包）。
- **当日花费**：由 DSH 真实的每步用量事件（`session/event` 里的 `assistant/message.usage`）按上面的价目表和**该步发生时刻**的峰谷价累加得出 —— 不是用余额差估算，所以不会因为余额接口的缓存延迟而滞后或算错。
- **持久化**：按北京日期累计，写入 `$DSH_HOME/dsh-balance-peek/ledger.json`（默认 `~/.dsh/dsh-balance-peek/ledger.json`），保留约 400 天，重启不丢当日进度。
- 余额上升会被识别为**充值**并单独计数，不会污染当日花费。

## 结构

```
dsh-balance-peek/
├─ package.json         声明 dsh.bundle.patch 与 dsh.client
├─ cordis.patch.yml     把插件插入 profile 的加载树
└─ lib/
   ├─ index.js          Host 半区：取余额、记账、暴露只读路由
   └─ client.js         浏览器半区：注册到 sidebar.footer.action 的 React 组件
```

`lib/client.js` 是**手写的** `window.__ModuleLoader__.load({ id, factory })` 注册行 —— 这正是 `@deepseek-ai/dsh-client-modules` 在 `/plugins` 上提供的、由外壳惰性加载的唯一入口形态。`factory` 内的 `require` 走外壳的平台模块表，React 由页面本身提供，因此**本插件没有任何构建步骤**，两个半区都是可直接阅读的源码。

Host 半区暴露一个只读接口：

```
GET /dsh-balance/state.json[?refresh=1]
```

## 兼容性

| 依赖 | 说明 |
| --- | --- |
| DeepSeek Harness | 开发与验证于 `0.2.0-rc.2`（桌面 profile）。用到的服务是 `credentials` / `deepseekAccount` / `sessions` / `webServer`，插槽是 `sidebar.footer.action`。 |
| 浏览器半区 | 走 `dsh.client` 客户端模块体系：`platform: web` |
| Node | ≥ 20（Host 半区只用 `node:fs` / `node:os` / `node:path` 与全局 `fetch`） |

## 安全说明

- 只读接口，**没有**任何写入能力或设置项。
- API key 只在 Host 进程内用于请求官方接口，**从不下发到浏览器**；发出去的数据只有余额数字、当日汇总和时段状态。
- 请求经过三层校验：回环/同源自检，然后委托 DSH 自己的 `connection.requestRejection`（含浏览器会话鉴权）。栅栏缺失时自检仍然生效，不会静默放行。确需从别的 Host 名访问（反代/局域网），设 `DSH_BALANCE_TRUSTED_HOSTS`（逗号分隔 `host:port`）。

## 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 侧边栏底部什么都没有 | 包名没进 profile `package.json` 的 `dsh.profile.bundles`（只 add 依赖不算挂载）。补上后刷新页面。 |
| 显示 `未配置 DEEPSEEK_API_KEY…` | 该 key 不在 DSH 凭据里，且当前未登录 DeepSeek 账号。到「设置 → 模型」配置 API Key。 |
| 余额是 `—` | 接口请求失败，展开明细能看到具体错误（HTTP 状态、超时等）。 |
| 当日花费比预期少 | 只统计**插件加载之后**发生的用量事件；插件未运行期间的消耗不会补记。 |
| 数字不刷新 | 插件每分钟轮询一次；点一下那两行可强制刷新。 |

## 开发

没有构建步骤：直接改 `lib/` 下的两个文件，然后刷新页面（客户端半区由 HMR 重新发布）。

仓库自带三套离线验证脚本（在 `_tools/` 中），不依赖浏览器：

- `verify-balance-host.mjs` — 用桩上下文挂载 Host 半区，驱动路由处理函数，断言峰谷判定、节假日、计价与账本累加。
- `verify-balance-client.mjs` — 用 `vm` 搭出 `window.__ModuleLoader__` 与桩 React，断言注册契约与两行结构的渲染结果。
- `audit-client-quotes.mjs` — 手写客户端半区的廉价结构体检（引号配平 + 可解析）。

```sh
node _tools/verify-balance-host.mjs
node _tools/verify-balance-client.mjs
node _tools/audit-client-quotes.mjs
```

## 许可

MIT
