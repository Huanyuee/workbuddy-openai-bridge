# 注册完 npm 账号后怎么继续

给未来的你（或任何人）看的操作单。所有准备工作已完成，只剩需要**你的 npm 账号**的两步。

## 你只需要跑这些

```sh
cd "C:\Users\Administrator\workbuddy-relay\pkg"

npm login          # 需要你的 npm 账号（浏览器或 OTP）
npm run preflight  # 复检，应全部 ok
npm publish        # 发布
```

然后推送标签：

```sh
git push --follow-tags
```

GitHub 仓库已就绪：https://github.com/Huanyuee/workbuddy-openai-bridge

> `git` 与 `gh` 不在系统 PATH 上。本机可用：
> - git: `C:\Users\Administrator\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe`
> - gh : `C:\Users\Administrator\gh-cli\gh.exe`

## 发布前已自动把关的事

`npm publish` 会先触发 `prepublishOnly` → `scripts/prepublish-check.js`，
逐项检查下面这些；任一项不合格就**拒绝发布**：

| 检查 | 为什么重要 |
|---|---|
| `private` 未设置 | 设了会直接阻止发布 |
| name / version / license / repository / description | registry 页面与溯源信息 |
| `engines.node` | 本包需要 ≥ 22.5（`node:sqlite`） |
| `files` 白名单 | 决定 tarball 装什么 |
| 每个 `bin` 存在**且有 shebang** | 没有 shebang，全局安装后命令无法执行 |
| 每个 `exports` 目标存在 | 断链的导出会让 `import` 失败 |
| tarball 不含 `.state/`、`tls/`、`.git`、`node_modules` | **防止把凭据或私钥发到公共 registry** |
| tarball 含 README / LICENSE / package.json | 合规 |
| 该版本号未被占用 | npm 不允许复用版本号 |
| 已登录 npm | 缺这个就是你现在唯一的状态 |

想要更保守，可以先只跑干跑：

```sh
npm publish --dry-run     # 列出最终会上传的每一个文件
```

## 发布后

```sh
# 确认 registry 上有了
npm view workbuddy-openai-bridge version

# 干净环境验证（真正模拟陌生人）
mkdir %TEMP%\verify && cd %TEMP%\verify
npm init -y
npm install workbuddy-openai-bridge
npx workbuddy-bridge --doctor
```

预期：认出 WorkBuddy、`sign-in : signed-in`、列出模型清单。

## 发布后要改的东西

README 目前写的是 **GitHub 源优先**，因为 npm 上还没有。发布后建议把顺序调回来，
让 `npm install -g workbuddy-openai-bridge` 和 `pi install npm:...` 重新成为首选：

- `README.md` → 「安装」与「用法一」两节
- `README.en.md` → `## Install` 与 `## Usage 1` 两节
- 删掉两处「尚未发布到 npm」的提示块

## 版本升级

```sh
npm version patch     # 或 minor / major，同时打 git tag
npm publish
git push --follow-tags
```

一个项目特有的判断：**WorkBuddy 上游接口形状变化**，若桥接仍可用算 `minor`，
若不可用算 `major`。

## 出问题时

```sh
npm deprecate workbuddy-openai-bridge@1.0.0 "原因；请用 1.0.1"
```

删包（unpublish）只在 72 小时内且限制很多。**优先发一个修好的版本并弃用旧的**，
而不是尝试删除。

## 已修复的两个发布阻断问题（供参考）

1. **`bin/cert.js` 缺 shebang** —— 全局安装后 `workbuddy-cert` 命令会失效。
2. **`WORKBUDDY_ELECTRON_BIN` 指向无效路径时被静默忽略** —— 会转而使用自动探测到的
   另一个安装。对别人机器上的排障是灾难（用错产品的密钥解密，报错离真正原因很远）。
   现在改为明确报错，绝不替换。

## 仍未做（等 npm 之后再考虑）

- 自动化 CI（GitHub Actions 跑 preflight）
- 英文 README 与中文的完全同步
