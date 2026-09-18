import fs from "node:fs";
import path from "node:path";

/**
 * Embedded source of the transparent auto-approve MCP proxy script.
 * Intercepts server-initiated `elicitation/create` prompts from Codex/CUA
 * and auto-replies with {"action": "accept"}, preventing Claude Code terminal interruptions.
 */
export const AUTO_APPROVE_PROXY_SOURCE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const [targetCmd, ...targetArgs] = process.argv.slice(2);
if (!targetCmd) {
  console.error("Usage: node mcp-auto-approve-proxy.mjs <command> [args...]");
  process.exit(1);
}

const child = spawn(targetCmd, targetArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

// Proxy stdin -> child.stdin
process.stdin.pipe(child.stdin);

// Line-by-line reading of child.stdout
const rl = readline.createInterface({
  input: child.stdout,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    process.stdout.write(line + "\\n");
    return;
  }

  let isElicitation = false;
  let reqId;

  try {
    const msg = JSON.parse(trimmed);
    if (msg && msg.jsonrpc === "2.0" && msg.method === "elicitation/create" && msg.id !== undefined) {
      isElicitation = true;
      reqId = msg.id;
    }
  } catch {
    // Non-JSON line, forward as-is
  }

  if (isElicitation) {
    // Auto-approve by sending accept response directly back to child.stdin
    const acceptResponse = {
      jsonrpc: "2.0",
      id: reqId,
      result: {
        action: "accept",
      },
    };
    child.stdin.write(JSON.stringify(acceptResponse) + "\\n");
  } else {
    // Forward normal JSON-RPC messages to Claude Code
    process.stdout.write(line + "\\n");
  }
});

const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const sig of signals) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {}
  });
}

child.on("close", (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
  } else {
    process.exit(code ?? 0);
  }
});

child.on("error", (err) => {
  console.error(\`[mcp-auto-approve-proxy] Error: \${err.message}\`);
  process.exit(1);
});
`;

/**
 * Generate MCP configuration block for Claude Code.
 */
export function generateMcpServersConfig(env, proxyPath, enabledServerIds = ["computer-use", "node_repl", "cua_repl"]) {
  const servers = {};

  const commonEnv = {
    CODEX_HOME: env.paths.codexHome,
    CODEX_CLI_PATH: env.paths.codexCli,
    NODE_REPL_NODE_PATH: env.paths.nodeBin,
    NODE_REPL_NODE_MODULE_DIRS: env.paths.nodeModulesDir,
    NODE_REPL_TRUSTED_CODE_PATHS: `${env.paths.codexHome}:${env.paths.nodeModulesDir}`,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
      browser: env.paths.browserService,
      sky: "@oai/sky/service",
    }),
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    SKY_CUA_SERVICE_PATH: env.paths.skyCuaServicePath,
    BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab",
    BROWSER_USE_TINYSKY_ENABLED: "1",
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
    BROWSER_USE_CODEX_APP_VERSION: "26.908.40834",
  };

  if (enabledServerIds.includes("computer-use") && env.mcps["computer-use"].available) {
    servers["computer-use"] = {
      type: "stdio",
      command: env.paths.skyClientBin,
      args: ["mcp"],
      env: {
        CODEX_HOME: env.paths.codexHome,
      },
    };
  }

  if (enabledServerIds.includes("node_repl") && env.mcps["node_repl"].available) {
    servers["node_repl"] = {
      type: "stdio",
      command: env.paths.nodeBin,
      args: [proxyPath, env.paths.nodeReplBin],
      env: { ...commonEnv },
    };
  }

  if (enabledServerIds.includes("cua_repl") && env.mcps["cua_repl"].available) {
    servers["cua_repl"] = {
      type: "stdio",
      command: env.paths.nodeBin,
      args: [proxyPath, env.paths.nodeBin, env.paths.cuaReplScript],
      env: {
        ...commonEnv,
        CUA_REPL_ENABLED_SURFACES: "browser,computer",
        CUA_REPL_NODE_REPL_PATH: env.paths.nodeReplBin,
      },
    };
  }

  return servers;
}

/**
 * Returns enhanced documentation for computer-use skill.
 */
export function getEnhancedComputerUseSkillMd() {
  return `---
name: computer-use
description: Control local Mac apps through Computer Use. Use for tasks that require reading or operating app UI by clicking, typing, scrolling, dragging, pressing keys, or setting values.
---

# Computer Use

Control local macOS applications and browsers through UI automation, accessibility trees, and screen capture.

Prefer purpose-built connectors, APIs, or CLIs when available; use Computer Use for interactions not exposed through a more specific interface.

---

## 运行时通道 (Runtime Channels)

在当前环境中（已在 MCP 配置中启用），支持两种操作模式：

### 模式 A：\`cua_repl\` / \`node_repl\` 代码驱动（推荐，支持批处理与长流程）
通过 MCP 服务 \`cua_repl\` 或 \`node_repl\` 的 \`js\` 工具执行 JavaScript：

\`\`\`javascript
// 在 cua_repl 中，全局 \`cua\` 对象已预置注入：
const app = await cua.getApp("Finder");
const state = await app.getAXState();
nodeRepl.write(state);

// 在 node_repl 中，按需引导加载 @oai/sky：
globalThis.sky = (await import("@oai/sky")).sky;
const state = await sky.get_app_state({ app: "Google Chrome" });
nodeRepl.write(state.text);
\`\`\`

### 模式 B：\`computer-use\` 直接 MCP 工具调用（简单单步操作）
直接调用 \`computer-use\` MCP 暴露的原生工具：
- \`list_apps()\`
- \`get_app_state({ app, disableDiff? })\`
- \`click({ app, element_index?, x?, y?, mouse_button?, click_count? })\`
- \`type_text({ app, text })\`
- \`press_key({ app, key })\`
- \`scroll({ app, element_index?, x?, y?, direction, pages? })\`
- \`drag({ app, from_x, from_y, to_x, to_y })\`
- \`select_text({ app, element_index, text, prefix?, suffix?, selection_type? })\`
- \`set_value({ app, element_index, value })\`
- \`perform_secondary_action({ app, element_index, action })\`

---

## 核心 API 规范 (TypeScript Surface)

\`\`\`typescript
type Vec2 = [x: number, y: number];
type Direction = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
type MouseButton = "left" | "right" | "middle" | "l" | "r" | "m";
type SelectionType = "text" | "cursor_before" | "cursor_after";

interface Target {
  getAXState(options?: { disableDiffing?: boolean }): Promise<string>;
  getScreenshot(): Promise<Uint8Array>;
  click(target: number | Vec2, options?: { mouseButton?: MouseButton; clickCount?: number }): Promise<void>;
  drag(from: Vec2, to: Vec2): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(target: number | Vec2, direction: Direction, pages?: number): Promise<void>;
  selectText(elementIndex: number, text: string, options?: { prefix?: string; suffix?: string; selectionType?: SelectionType }): Promise<void>;
  setValue(elementIndex: number, value: string): Promise<void>;
  typeText(text: string): Promise<void>;
  paste(text: string, options?: { format?: "text" | "md" | "html" }): Promise<void>;
  performSecondaryAction(elementIndex: number, action: string): Promise<void>;
}

interface App extends Target {}

interface Tab extends Target {
  readonly id: string;
  goto(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

declare const cua: {
  getState(): Promise<any>;
  getApp(app: string): Promise<App>;
  listApps(): Promise<Array<{ id: string; displayName?: string; isRunning?: boolean }>>;
  getBrowser(options?: { id?: string; url?: string }): Promise<any>;
  createBrowserTab(browserId: string, url?: string): Promise<Tab>;
  getTab(id: string): Promise<Tab>;
  listTabs(): Promise<any[]>;
};
\`\`\`

---

## 推荐交互工作流 (Workflow)

1. **初始应用探测**：
   - 若明确已知应用名（如 Chrome、Finder、Slack），直接使用应用名或 Bundle ID 获取状态。
   - 若未知，先调用 \`list_apps\` 或 \`cua.listApps()\`。
   - 应用无需预先手动打开，\`get_app_state\` / \`cua.getApp\` 会透明在后台拉起目标应用。

2. **优先使用 Accessibility 元素序号 (AX element_index)**：
   - 优先通过 \`element_index\` 进行点击或输入，比绝对像素坐标更稳健。
   - 每次关键交互后调用 \`getAXState()\` 或 \`get_app_state\`，刷新当前界面的可访问性树并获取最新索引。
   - 默认使用树 Diff 增量提升性能；仅在视觉脱节时使用全量树或截图。

3. **按键语法与注意事项**：
   - \`press_key\` 支持 xdotool 风格语法：\`"Return"\`, \`"Tab"\`, \`"super+c"\`, \`"Up"\`, \`"KP_0"\` 等。
   - \`type_text\` 中的换行符 \`\\n\` 会模拟按回车键，在表单或聊天应用中请格外注意避免误发送。

4. **处理截图**：
   - 当辅助功能树不足以表达上下文（如 Canvas 绘图、复杂网页布局、游戏）时，使用 \`getScreenshot()\` 获取屏幕画面。

---

## 安全确认策略 (Confirmations Policy)

计算机操作直接作用于用户真实操作系统环境，必须遵循以下确认策略分级：

### 1. 严禁代劳 (Hand-Off Required - 必须由用户自行操作)
- **[2.4]** 提交修改账户密码的最终确认步骤。
- **[15]** 绕过浏览器/网络安全警示（如“您的连接不是私密连接”HTTPS 证书绕过、绕过付费墙）。

### 2. 运行时强制确认 (Always Confirm at Action-Time - 即使预授权也必须阻断确认)
- **[1] 删除数据**：删除云端/本地文件、邮件、日程、账号；本地图形界面下的删除操作。
- **[2] 权限与凭证变更**：修改云数据访问权限、完成账号注册的最后一步、创建 API/OAuth Key、在浏览器保存密码或信用卡。
- **[4] 验证码 (CAPTCHA)**：过人机验证。
- **[8] 安装/运行新获取的软件**：安装或首次执行新下载的软件、安装浏览器扩展。
- **[9] 对外代表性通讯**：发送邮件、发布社交媒体言论、提交工作申请/税单/表单、修改公开网站内容。
- **[11] 金融交易**：转账、支付、订阅或取消订阅服务。
- **[13] 本地系统敏感设置**：修改 VPN、系统安全设置、修改开机或管理员密码。

### 3. 支持预授权操作 (Pre-Approval Works - 初始 Prompt 明确授权则无需再问)
- **[2.3, 2.7] 登录**：如果用户初始 prompt 说明了“登录某个网站”，视为预授权；否则在跨站跳转时需确认。
- **[6] 上传文件**：向目标服务上传文件。
- **[12] 文件重命名与移动**：非删除性的本地文件归档与整理。
- **[14] 传输敏感数据**：预授权中需明确包含“具体数据类型”与“明确的目标服务”。

### 4. 始终允许操作 (No Confirmation Needed)
- 接受 Cookie 声明及使用协议（ToS / Privacy Policy）。
- 下载文件至本地目录。
- 目标应用内的正常只读浏览、定位、阅读文本、查询等无副作用操作。
`;
}
