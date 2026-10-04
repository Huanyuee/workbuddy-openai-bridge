# workbuddy-openai-bridge

把 **WorkBuddy 桌面 App** 的登录态变成标准 **OpenAI 兼容端点**，让 Pi（`pi-coding-agent`）、
MolaGPT 以及任何 OpenAI 兼容客户端直接使用 WorkBuddy 账号里的模型。

```
Pi / MolaGPT / 任意 OpenAI 客户端
        │  OpenAI 兼容 (HTTP/HTTPS)
        ▼
workbuddy-openai-bridge ──► copilot.tencent.com
        │
        └── 凭据来自 WorkBuddy 桌面 App 登录态
```

## 前置条件

1. **已安装并登录 WorkBuddy 桌面 App**（或国际版 WorkBuddy AI）
   - 登录一次即可，**之后不需要保持运行**
   - 但 **App 本体不能卸载**：WorkBuddy 5.6 起 token 加密存储，
     需要调用 App 的可执行文件才能解密
2. **Node.js ≥ 22.5**（`node:sqlite` 与 `AbortSignal.any` 的需要）

## 安装

```sh
npm install -g workbuddy-openai-bridge
```

或作为依赖装进项目：

```sh
npm install workbuddy-openai-bridge
```

## 用法一：Pi 扩展（推荐）

```sh
pi install npm:workbuddy-openai-bridge
```

装完即用，**无需任何配置**：Pi 会自动发现扩展，扩展在进程内拉起桥接
（临时端口，不需要单独守护进程），并注册 `workbuddy` provider。

之后在 Pi 里就能选到这些模型：

```
provider   model                   context  max-out  thinking  images
workbuddy  wb/hy4-preview          960K     64K      yes       yes
workbuddy  wb/deepseek-v4.1-flash  1M       128K     yes       yes
workbuddy  wb/glm-5.3              1M       64K      yes       yes
workbuddy  wb/kimi-k2.6            256K     32K      yes       yes
...共 19 个
```

```sh
# 直接用某个模型
pi --model wb/hy3 -p "你好"

# 只跑一次，不安装
pi -e node_modules/workbuddy-openai-bridge/extensions/workbuddy.js --model wb/glm-5.3
```

> **注意：`pi install` 只对独立的 Pi 有效。**
> MolaGPT 内置的 Pi sidecar 用 `--no-extensions` 启动，会跳过这里安装的扩展，
> 所以 MolaGPT 用户请用下面的用法二。

## 用法二：MolaGPT 一键接入

MolaGPT 有个坑：它的「自动获取」会用一份**硬编码的厂商标识词表**过滤模型名
（`LooksLikeChatModel`），19 个 WorkBuddy 模型里只有名字含 `deepseek` 的 2 个能通过，
其余全部被丢弃。

本包直接把这些模型写进 MolaGPT 的 provider 记录，绕过该过滤：

```sh
# 1. 先在 MolaGPT 里添加服务商：
#    类型    OpenAI 兼容
#    地址    https://localhost:9443/v1
#    API Key 随便填（桥接不校验）

# 2. 完全退出 MolaGPT

# 3. 启动桥接（需要它在线，脚本要从上游读模型目录）
workbuddy-bridge

# 4. 预览将要写入的内容（不改数据库）
workbuddy-setup-molagpt

# 5. 确认后写入
workbuddy-setup-molagpt --apply

# 6. 重启 MolaGPT
```

脚本会：
- 写入前**自动备份**数据库到 `~/MolaGPT-backup/molagpt-<时间戳>.db`
- 检测到 MolaGPT 正在运行就**拒绝写入**（运行中的实例会用内存里的旧列表覆盖）
- 默认 dry-run，必须显式加 `--apply`

> 写入后**先重启 MolaGPT，再进设置页**。运行中的实例若在重启前保存该服务商，
> 会用内存里的旧列表覆盖这次写入。

## 用法三：独立服务

适合任何 OpenAI 兼容客户端（SillyTavern、Cherry Studio、自建脚本等）。

```sh
# 前台运行
workbuddy-bridge

# 自定义端口 / 只开 HTTP
workbuddy-bridge --port 8899 --no-https

# 国际版 WorkBuddy AI
workbuddy-bridge --variant ai

# 诊断（不启动服务）
workbuddy-bridge --doctor
```

默认监听：

| 地址 | 说明 |
|---|---|
| `http://127.0.0.1:8899/v1` | OpenAI 兼容（明文） |
| `https://localhost:9443/v1` | OpenAI 兼容（TLS，需提供证书） |
| `GET /v1/models` | 模型列表 |
| `POST /v1/chat/completions` | 对话（支持 `stream`） |
| `GET /health` | 健康状态、登录态、模型数 |

HTTPS 用 `--pfx` 指定 PKCS#12 证书，或直接用下面的 `workbuddy-cert` 生成并信任一张。

**自签证书必须已被系统信任**，否则客户端（尤其 .NET 系）会拒绝。
用 `localhost` 而非 `127.0.0.1` 访问更稳妥。

## 证书：生成 + 装进信任库

MolaGPT 这类 .NET 应用会校验证书链，自签证书不装进信任库就用不了。
这条命令把「生成」和「让系统信任」一次做完，也能完整撤销：

```sh
workbuddy-cert create     # 生成密钥与证书（不动信任库）
workbuddy-cert trust      # 装进当前用户信任库
workbuddy-cert status     # 查看状态与是否已信任
workbuddy-cert untrust    # 从信任库移除（只删自己的那张）
workbuddy-cert untrust --purge   # 连证书文件一起删
```

装好后 `workbuddy-bridge` 会自动使用它，无需再传 `--pfx`。

### 安全设计

装证书进信任库是敏感操作，所以：

- **绝不自动执行**，必须你显式运行 `workbuddy-cert trust`
- **删除只按证书指纹**，绝不按名字匹配。这点很重要：一台机器上可能已经存在
  好几张无关的 `CN=localhost` 证书（本机就有 3 张），按名字删会把它们一起清掉，
  弄坏别的工具
- `untrust` **只会删掉本包生成的那一张**，动不了别人的
- 默认作用域是**当前用户**（不需要管理员权限）；装到全机器需要显式加 `--machine`
  并会给出警告

### 选项

| 参数 | 说明 |
|---|---|
| `--hostname <name>` | 主 DNS 名（默认 `localhost`） |
| `--extra-host <列表>` | 额外域名/IP，逗号分隔 |
| `--days <n>` | 有效期天数（默认 3650） |
| `--machine` | 使用全机器存储（需管理员） |
| `--state-dir <path>` | 状态目录 |

生成的证书包含 `localhost` 与 `127.0.0.1` 两个 SAN，所以两种写法都能用。
该功能依赖可选的 `selfsigned` 包；未安装时只有这一条命令不可用，其余功能不受影响。


## 模型前缀

对外模型名统一带 `wb/` 前缀，方便区分来源。前缀是**纯展示层**：
`/v1/models` 输出时加上，对话请求收到后剥掉再转发，上游只看到真实 id。

```sh
workbuddy-bridge --prefix ""        # 关闭前缀
export WORKBUDDY_MODEL_PREFIX=wb/   # 环境变量方式
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_VARIANT` | `cn` | `cn` 或 `ai` |
| `WORKBUDDY_MODEL_PREFIX` | `wb/` | 模型名前缀 |
| `WORKBUDDY_BRIDGE_STATE` | `~/.workbuddy-openai-bridge` | 凭据副本目录 |
| `WORKBUDDY_ELECTRON_BIN` | 自动探测 | WorkBuddy.exe 路径 |
| `WORKBUDDY_AI_ELECTRON_BIN` | 自动探测 | WorkBuddyAI.exe 路径 |

CLI 参数优先于环境变量，详见 `workbuddy-bridge --help`。

## 排障

**`not signed in`**
在 WorkBuddy 桌面 App 里登录一次，然后重启桥接或 `/reload`。

**`no WorkBuddy binary found` / `no WorkBuddy Electron binary is configured`**
自动探测没找到 App，手动指定：

```sh
# Windows
set WORKBUDDY_ELECTRON_BIN=%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe
# macOS
export WORKBUDDY_ELECTRON_BIN="/Applications/WorkBuddy.app/Contents/MacOS/Electron"
```

**模型列表为空**
先 `workbuddy-bridge --doctor` 看 `sign-in` 与 `models` 两行。

**MolaGPT 里只显示 2 个 deepseek 模型**
这是 MolaGPT 的过滤行为，用「用法二」的脚本写入即可（见上文说明）。

## 它是怎么工作的

- **凭据**：直接复用 `dsh-workbuddy-connect`（DSH 官方插件生态的同名包），
  它实现了 WorkBuddy 的凭据解密、目录拉取与上游协议
- **凭据隔离**：本包使用**自己**的凭据副本目录，绝不与 DSH 插件的
  `~/.dsh/.workbuddy-auth.json` 共用——两个写者抢同一个 refresh token 会互相踢掉
- **协议适配**：上游要求强制流式与字符串形式的 `tool_choice`，
  由 `prepareChatBody` 完成；上游本身已是 OpenAI 形态（含 `reasoning_content`），
  桥接只做轻量清理
- **响应归一化**：去掉上游固定回传的空 `tool_calls`/`function_call`，
  把 `finish_reason: ""` 改成 `null`

## 验证状态

以下均在真实 WorkBuddy 账号上实测通过：

| 项目 | 结果 |
|---|---|
| 加密凭据解密 | ok |
| 模型目录 | 19 个 |
| 非流式对话 | ok |
| 流式对话（SSE + `[DONE]`） | ok |
| `reasoning_content` 透传 | ok（glm-5.3 实测 236 个分片） |
| `wb/` 前缀剥离 | ok（`wb/glm-5.3` → `glm-5.3`） |
| Pi 扩展：`pi install` 后自动发现 | ok |
| Pi 扩展：真实对话 | ok |
| Pi 扩展：模型元数据（context/thinking/images） | ok |
| 凭据与 DSH 隔离 | ok |
| 独立服务 HTTP / HTTPS | ok |
| `workbuddy-cert create` + SAN 正确 | ok |
| `workbuddy-cert trust` 后**默认校验**通过 | ok |
| `workbuddy-cert untrust` 只删自己那张 | ok（本机原有 3 张全部保留） |
| 净安装（tarball → 全新目录） | ok |

## 已知限制

- 依赖 WorkBuddy 客户端**私有接口**（非官方开放 API），上游更新后可能失效
- 国际版（`--variant ai`）的模型目录来自 App 界面接口，稳定性弱于国内版的 CLI 同款接口
- Pi 的 `calculateCost()` 会无条件读取 `model.cost`，而 WorkBuddy 以自家积分计费、
  并非美元，因此本包统一填 0，避免 Pi 编造金额
- Windows 上 `pi install` 写入的是**相对路径**，移动目录后会失效，需重新安装

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用
- 请遵守 WorkBuddy 的服务条款；账号被限制、额度被清空等后果自负
- 与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可

## 许可证

MIT
