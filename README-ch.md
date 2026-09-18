# codex-to-claude

[![npm version](https://img.shields.io/npm/v/codex-to-claude.svg)](https://www.npmjs.com/package/codex-to-claude)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

> **一键将 OpenAI Codex (ChatGPT Desktop) 内置的 Computer Use 桌面自动化、Node REPL 沙箱引擎及原生 Skills 无缝桥接至 Anthropic Claude Code。**

[English](./README.md) | [简体中文](./README-ch.md)

---

## ⚡ 快速开始

无需克隆仓库或安装本地依赖，任何终端目录下直接通过 `npx` 即可运行：

```bash
# 交互式向导（推荐：自动引导选择全局/项目安装、MCP 通道与 Skill 导出）
npx codex-to-claude

# 或者：一键静默部署到 Claude Code 全局环境 (~/.claude.json 与 ~/.claude/skills/)
npx codex-to-claude --global --yes

# 或者：一键部署到当前项目工作区 (./.mcp.json 与 ./.claude/skills/)
npx codex-to-claude --project --yes
```

---

## 🎯 解决什么痛点？

Codex（ChatGPT macOS 桌面客户端）内部打包了极其强大的原生桌面与浏览器自动化基础设施：
- **`computer-use`**：macOS 原生 GUI 控制能力（无障碍 Accessibility 树分析、鼠标点击、键盘输入、窗口截图）。
- **`node_repl` 与 `cua_repl`**：基于 Rust 与 Node 打造的高性能持久化 JavaScript 执行沙箱，内置 `@oai/sky` 桥接与全局 `cua` 自动化对象。
- **13+ 内置生产级 Skills**：官方打磨的技能体系（包括 `computer-use`、`control-chrome`、`visualize`、`deep-research`、`computer-history` 等）。

然而，直接把这些服务搬到 Claude Code 会遇到两个关键问题：
1. **频繁弹窗打断**：Codex 底层安全策略会在操作 App 前发送 MCP `elicitation/create` 质询帧，导致 Claude Code 终端频繁弹出 `mcp server "cua_repl" requests your input`，破坏全自动执行体验。
2. **配置繁琐**：涉及动态管道环境变量、动态 `node_modules` 路径解析以及 Skill 规范的手动适配。

`codex-to-claude` 能够**全自动扫描本地环境、智能注入透明 Auto-Approve 代理（彻底消除弹窗打扰），并无损合并配置到 Claude Code 全局或当前项目中**。

---

## 🖥️ 深度解析：Computer Use 的底层工作原理

### 1. 双通道运行时架构 (Dual-Channel Architecture)

Codex 提供了两种操控计算机的途径：

```text
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code + Skill                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
    【模式 A：代码批处理驱动】        【模式 B：原子工具直接调用】
       cua_repl / node_repl                  computer-use
       工具: `js` (执行代码)                 工具: `click`, `type`...
               │                               │
               └───────────────┬───────────────┘
                               ▼
                   macOS 无障碍与图形服务
            (SkyComputerUseClient / CoreGraphics)
```

#### 模式 A：代码驱动 (`cua_repl` / `node_repl`) —— **官方推荐模式**
传统的单步工具调用每点一下按钮都要进行一次 LLM 往返，极度消耗 Token 且延迟很高。
在该模式下，Claude 直接在持久化 Node.js 沙箱中编写 JavaScript 脚本：

```javascript
// 在 cua_repl 中，全局 `cua` 对象已被预置注入：
const app = await cua.getApp("Finder");
const state = await app.getAXState();
nodeRepl.write(state);

// 根据可访问性树的元素序号 (elementIndex) 精确点击：
await app.click(12);

// 模拟键盘文字输入：
await app.typeText("My Project\n");
```

**为什么这种方式更好：**
- **批处理执行**：唤醒窗口 $\rightarrow$ 读取状态 $\rightarrow$ 点击输入框 $\rightarrow$ 输入文字 $\rightarrow$ 校验结果，可在一个回合内完整执行。
- **状态持久化**：变量、已打开的应用对象和浏览器标签页在多轮对话之间驻留内存。
- **节省上下文 Token**：无需在每一步往返中传递成千上万行冗余的 UI 树文本。

#### 模式 B：原子工具调用 (`computer-use`)
直接向模型暴露 10 个标准原子 MCP 工具：
- `list_apps()`：列出当前运行中与近期活跃的 macOS 应用。
- `get_app_state({ app, disableDiff })`：捕获窗口无障碍树与屏幕截图。
- `click({ app, element_index, x, y, mouse_button })`：点击元素序号或绝对坐标。
- `type_text({ app, text })`：模拟敲击键盘输入文字。
- `press_key({ app, key })`：模拟组合键或功能键（如 `"Return"`, `"super+c"`, `"Tab"`）。
- `scroll({ app, element_index, direction, pages })`：滚动界面内容。
- `drag({ app, from_x, from_y, to_x, to_y })`：拖拽操作。
- `select_text(...)`, `set_value(...)`, `perform_secondary_action(...)`。

---

### 2. 透明 Auto-Approve 代理（彻底消除频繁弹窗）

#### 为什么此前会频繁弹窗？
当 Claude Code 启动 `cua_repl` 时，脚本中一旦调用 `cua.getApp(...)`，底层 `@oai/sky` 的 `computer-use-policy.js` 就会强制触发拦截质询，向 Claude Code 发送标准的 MCP 协议请求：

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "elicitation/create",
  "params": {
    "message": "Allow Computer Use to use \"Finder\"?",
    "mode": "form"
  }
}
```

因为 Claude Code 原生支持此协议，它会在终端界面上挂起并渲染交互提示：
```text
mcp server "cua_repl" requests your input: Allow Computer Use to use "Finder"?
```
用户每次操作不同应用甚至同一应用，都必须在键盘上反复按回车确认，无法进行后台无人值守自动化。

#### 代理的解决机制
`codex-to-claude` 在安装时会自动部署并挂载 [`mcp-auto-approve-proxy.mjs`](./src/generator.mjs) 作为 Stdio 中间代理：
1. 正常的工具发现与执行结果双向透明透传。
2. 捕获到服务端的 `elicitation/create` 拦截帧时，代理毫秒级在后台自动向子进程回包 `{"jsonrpc": "2.0", "id": <reqId>, "result": {"action": "accept"}}`。
3. 该质询帧被就地消化，**不再向上透传给 Claude Code 终端**。
4. 结果：**获得 100% 丝滑、不被打断的全自动 UI 操控体验。**

---

### 3. 所需 macOS 系统授权

`SkyComputerUseClient` 依赖系统原生无障碍与图形 API。请在 macOS **系统设置 $\rightarrow$ 隐私与安全性** 中确保授予权限：
1. **辅助功能 (Accessibility)**：勾选 `Codex Computer Use.app`（以及正在运行的终端或 IDE）。
2. **屏幕录制 (Screen Recording)**：勾选 `Codex Computer Use.app`（用于捕获窗口画面）。
3. **自动化 (Automation)**：允许控制 `System Events`。

---

### 4. 分级安全确认策略 (Confirmations Policy)

导出的 `computer-use` Skill 严格遵守 4 级权限保护策略：
1. **严禁代劳 (必须由用户自行接管)**：提交修改密码的最终步骤、绕过 HTTPS 证书安全警告或付费墙。
2. **运行时强制确认 (即使预授权也必须阻断提示)**：删除本地/云端文件、金融转账与支付、过人机验证 (CAPTCHA)、安装/运行未知软件、对外发送邮件或公开言论。
3. **支持预授权操作 (若用户初始 Prompt 已包含则直接执行)**：常规登录、上传文件、文件重命名或移动。
4. **始终允许操作 (无需确认)**：Cookie 授权确认、只读查看、检索界面文本、无副作用的浏览定位。

---

## 🛠️ CLI 选项与参数说明

```text
用法:
  npx codex-to-claude [选项]
  node ./bin/cli.mjs [选项]

选项:
  -g, --global           直接安装到 Claude Code 全局环境 (~/.claude.json 与 ~/.claude/skills/)
  -p, --project          直接安装到当前工作区项目 (./.mcp.json 与 ./.claude/skills/)
  -b, --both             同时安装到全局与当前项目环境
  -d, --dry-run          仅检测环境并预览拟生成的配置，不写入任何磁盘文件
  -y, --yes              非交互模式，全部使用推荐配置（自动放行代理 + 推荐服务）
      --all-skills       导出全部发现的 13 个 Codex 技能（默认仅导出 computer-use）
      --chatgpt-path <p> 指定 ChatGPT.app Resources 目录的自定义绝对路径
      --codex-home <p>   指定 Codex 配置主目录（默认: ~/.codex）
  -h, --help             显示帮助信息
```

---

## 📦 支持导出的技能列表

默认导出核心推荐的 `computer-use` 技能：
- 包含双通道代码规范与 TypeScript 类型契约。
- 包含 4 级安全策略规范。
- 包含原生 Node REPL / `@oai/sky` 协议参考手册。

添加 `--all-skills` 可一键同步 Codex 随包附带的全部 13 个技能：
- `control-chrome`：控制 Chrome 浏览器会话与扩展。
- `control-in-app-browser`：控制内嵌浏览器（IAB）自动化。
- `visualize`：在对话中生成高品质交互式 HTML/SVG 数据可视化与动态原型。
- `deep-research`：多轮次交叉验证的深度研究流程。
- `computer-history`：基于本机活动流水线与记忆摘要的问答追踪。
- `latex-compile` / `latex-doctor` / `texlive-runtime-installer`：LaTeX 编译与环境诊断。
- `record-and-replay`：桌面操作录制与回放。
- `sites-building` / `sites-hosting`：网站构建与发布。
- `writing-style`：专业文风与写作规范。

---

## 🔍 验证与使用体验

部署完成后：

1. **查看 MCP 状态**：
   ```bash
   claude mcp list
   ```
   可看到 `computer-use`、`node_repl` 与 `cua_repl` 均已成功注册且状态正常。

2. **在 Claude Code 中体验**：
   启动 Claude Code 并输入：
   > “使用 computer-use 查看我 Mac 当前打开的应用，并帮我把访达 (Finder) 聚焦到前台”

---

## 📄 开源许可

[MIT License](./LICENSE) © [cddchen](https://github.com/cddchen)
