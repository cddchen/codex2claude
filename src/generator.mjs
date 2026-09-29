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

When this skill is invoked, the user explicitly requests direct GUI operations. Use \`cua_repl\` to interact with target applications or browsers. **Do NOT fall back to CLI tools, AppleScript (\`osascript\`), or background scripts to bypass GUI automation.**

---

## Runtime & Bootstrapping

All UI interactions run via the \`cua_repl\` MCP service (\`js\` tool). The global \`cua\` object is pre-injected into the runtime.

### First Call Constraint (Acquire Target & Read Dynamic Docs)

On your first call, or immediately after a \`js_reset\`, **you MUST execute exactly ONE entry API call** (e.g., getting a target application or inspecting global state). **Do NOT chain additional actions, waits, or screenshots in the first call.**

**Core Mechanism**: The return value of the first call **automatically includes the full, latest TypeScript API specification and initial UI accessibility state**. Read this dynamic result first, then write specific interaction logic in subsequent calls.

\`\`\`javascript
// Correct first call: bind target application and retain the persistent reference
let app = await cua.getApp("Safari");
// When target app is unknown: await cua.getState(); or await cua.listApps();
\`\`\`

Do NOT use the following pattern on the first call (chaining actions/waits/screenshots is strictly prohibited):
\`\`\`javascript
// WRONG: Chaining multiple actions, delays, and screenshots in the first call
{
  const app = await cua.getApp("Simulator");
  await app.drag([190, 250], [190, 750]);
  await app.getScreenshot();
}
\`\`\`

---

## Claude Code Host Adaptations & Critical Pitfalls

The underlying Computer Use capability was originally designed for Codex. When running under generic MCP hosts like Claude Code, **you must strictly follow these rules**:

1. **Treat Safari & Desktop Browsers as Native Apps**:
   Generic MCP clients do not provide Codex-proprietary session metadata (\`x-codex-turn-metadata\`). Calling browser tab management APIs (\`cua.listTabs()\` or \`cua.getBrowser()\`) will fail with: \`Missing required Codex turn metadata: session_id, turn_id\`.
   **Correct usage**: Bind Safari and desktop browsers directly as Native Apps:
   \`\`\`javascript
   let safari = await cua.getApp("Safari");
   await safari.getAXState();
   await safari.click(index);
   await safari.setValue(index, "text");
   \`\`\`
2. **Never Manually Import or Script Against \`@oai/sky\`**:
   Always interact through the pre-injected \`cua\` interface. The underlying \`@oai/sky\` module uses a completely different flat parameter contract (e.g., \`sky.click({ app, element_index })\`), which will cause immediate failures if called like high-level methods.
3. **Reset on Hangs or Errors**:
   If an interaction times out, errors out, or the UI state becomes desynchronized, immediately call \`mcp__cua_repl__js_reset\` to reset the runtime kernel, then re-acquire the app reference. **Never attempt to reverse-engineer native closures using \`toString()\` or search internal filesystem temp directories.**

---

## Reliable Interaction Loop

After completing bootstrapping, reuse the persistent application variable across independent tool calls following this three-step loop:

1. **Observe**:
   - Call \`await app.getAXState();\` to fetch the accessibility tree with \`element_index\` (default incremental diff mode).
   - If visual context is lost or the window significantly changes, call \`await app.getAXState({ disableDiffing: true });\` for a full tree snapshot.
   - When visual layout, canvas, or complex graphics need inspection, call \`await app.getScreenshot();\` to capture the window image.
2. **Act**:
   - **Prefer accessibility element indices**: \`await app.click(index);\` / \`await app.setValue(index, "text");\`.
   - **Keyboard input**: \`await app.pressKey("Return");\` or \`await app.typeText("text");\` (note that \`\\n\` triggers Enter).
   - **Gestures & scrolling**: \`await app.scroll(index, "down", 2);\` or \`await app.drag([x1, y1], [x2, y2]);\`.
3. **Verify**:
   - Always re-fetch state with \`await app.getAXState();\` after significant interactions to confirm that the UI transitioned as expected before proceeding.
`;
}
