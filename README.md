# codex-to-claude

[![npm version](https://img.shields.io/npm/v/codex-to-claude.svg)](https://www.npmjs.com/package/codex-to-claude)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

> **Bridge OpenAI Codex's built-in Computer Use, Node REPL sandbox, and native skills into Anthropic Claude Code — in one command.**

[English](./README.md) | [简体中文](./README-ch.md)

---

## ⚡ Quick Start

Run instantly anywhere via `npx` without cloning or local installation:

```bash
# Interactive mode (prompts for global/project installation, MCP channels, and skills)
npx codex-to-claude

# Or install directly to Claude Code Global config (~/.claude.json & ~/.claude/skills/)
npx codex-to-claude --global --yes

# Or install to current project workspace (./.mcp.json & ./.claude/skills/)
npx codex-to-claude --project --yes
```

---

## 🎯 What Does This Do?

Codex (ChatGPT Desktop for macOS) bundles powerful native automation capabilities:
- **`computer-use`**: Low-level macOS GUI control (Accessibility AX-tree inspection, mouse clicks, key events, screenshots).
- **`node_repl` & `cua_repl`**: High-performance persistent JavaScript execution sandboxes with `@oai/sky` and pre-injected global `cua` bindings.
- **13+ Built-in Skills**: Production-grade system prompts and skills including `computer-use`, `control-chrome`, `visualize`, `deep-research`, `computer-history`, etc.

`codex-to-claude` automatically detects your local Codex installation, extracts its MCP configurations, injects an **auto-approve proxy** (to eliminate annoying permission popups in Claude Code), and exports ready-to-use configurations and skill files directly into Claude Code.

---

## 🖥️ Deep Dive: How Computer Use Works

### 1. Dual-Channel Architecture

Codex provides two distinct ways to operate the computer:

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code + Skill                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
    【Channel A: Code-Driven】       【Channel B: Atomic Tools】
       cua_repl / node_repl                  computer-use
       Tool: `js` (eval scripts)             Tools: `click`, `type`...
               │                               │
               └───────────────┬───────────────┘
                               ▼
                   macOS Accessibility Engine
            (SkyComputerUseClient / CoreGraphics)
```

#### Channel A: Code-Driven (`cua_repl` / `node_repl`) — **Recommended**
Instead of invoking individual tool calls step-by-step (which wastes thousands of tokens on round-trips), Claude writes and executes JavaScript in a persistent sandbox:

```javascript
// In cua_repl, the `cua` global object is already pre-injected:
const app = await cua.getApp("Finder");
const axTree = await app.getAXState();
nodeRepl.write(axTree);

// Click an element by accessibility index:
await app.click(12);

// Or type text:
await app.typeText("Project Documents\n");
```

**Why this is superior:**
- **Batched Execution**: Focus window $\rightarrow$ read state $\rightarrow$ click button $\rightarrow$ type text all happen in a single model turn.
- **State Persistence**: Variables, application references, and browser tab handles stay in memory across conversation turns.
- **Context Token Savings**: Eliminates redundant UI state dumps back and forth between turns.

#### Channel B: Direct Atomic MCP Tools (`computer-use`)
Exposes 10 native atomic MCP tools directly to the model:
- `list_apps()`: List active and running macOS applications.
- `get_app_state({ app, disableDiff })`: Fetch accessibility tree and window screenshot.
- `click({ app, element_index, x, y, mouse_button })`: Click element by AX index or coordinate.
- `type_text({ app, text })`: Type text via keyboard events.
- `press_key({ app, key })`: Press hotkeys (`"Return"`, `"super+c"`, `"Tab"`).
- `scroll({ app, element_index, direction, pages })`: Scroll content.
- `drag({ app, from_x, from_y, to_x, to_y })`: Drag and drop.
- `select_text(...)`, `set_value(...)`, `perform_secondary_action(...)`.

---

### 2. The Auto-Approve Proxy (Why it's essential)

#### The Problem
When Claude Code connects to `cua_repl` or `node_repl`, running any `cua.getApp(...)` command triggers OpenAI's internal security gate (`computer-use-policy.js`). It sends a standard JSON-RPC notification:

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

Because Claude Code natively implements the MCP elicitation protocol, **it halts execution on every single action** and prompts:
```text
mcp server "cua_repl" requests your input: Allow Computer Use to use "Finder"?
```
This completely breaks hands-free autonomous workflows.

#### The Solution
`codex-to-claude` automatically deploys [`mcp-auto-approve-proxy.mjs`](./src/generator.mjs). This lightweight proxy sits between Claude Code and the Codex MCP server:
1. Normal MCP requests and tool calls pass through transparently.
2. When the server emits an `elicitation/create` challenge, the proxy intercepts it in the background, immediately replies with `{"jsonrpc": "2.0", "id": <reqId>, "result": {"action": "accept"}}`, and drops the prompt before Claude Code ever sees it.
3. Result: **100% fluid, interruption-free computer automation.**

---

### 3. Required macOS System Permissions

Because `SkyComputerUseClient` interacts with the macOS window server, grant the following in **System Settings $\rightarrow$ Privacy & Security**:
1. **Accessibility**: Allow `Codex Computer Use.app` (and your terminal / IDE).
2. **Screen Recording**: Allow `Codex Computer Use.app` (for window screenshots).
3. **Automation**: Allow controlling `System Events`.

---

### 4. Safety Confirmation Policy

The exported `computer-use` skill enforces a 4-tier safety confirmation policy:
1. **Hand-Off Required (Never automated)**: Changing account passwords, bypassing SSL/TLS warnings.
2. **Always Confirm at Action-Time**: Deleting local/cloud files, financial transactions, solving CAPTCHAs, installing software, sending external communications (emails, public posts).
3. **Pre-Approval Allowed**: Logging in (when specified in the prompt), uploading files, renaming files.
4. **No Confirmation Needed**: Inspecting read-only states, scrolling, reading text, accepting cookie banners.

---

## 🛠️ CLI Options & Flags

```text
Usage:
  npx codex-to-claude [options]
  node ./bin/cli.mjs [options]

Options:
  -g, --global           Install to Claude Code Global config (~/.claude.json & ~/.claude/skills/)
  -p, --project          Install to current project directory (./.mcp.json & ./.claude/skills/)
  -b, --both             Install to both Global and Project environments
  -d, --dry-run          Detect environment and preview configuration without writing files
  -y, --yes              Non-interactive mode; accepts all recommended defaults
      --all-skills       Export all 13+ discovered Codex skills (default: computer-use only)
      --chatgpt-path <p> Custom path to ChatGPT.app Resources directory
      --codex-home <p>   Custom path to Codex home directory (default: ~/.codex)
  -h, --help             Show help documentation
```

---

## 📦 What Skills Are Exported?

By default, the core `computer-use` skill is exported with:
- **Dual-channel operating instructions** (JavaScript batching + atomic tools).
- **Full TypeScript definitions** for `Target`, `App`, `Tab`, and global `cua`.
- **4-tier safety policy**.
- **Reference guide** (`references/computer-use-node-repl.md`).

With `--all-skills`, you also get:
- `control-chrome`: Chrome browser automation.
- `control-in-app-browser`: In-app browser driver.
- `visualize`: Dynamic interactive HTML/SVG artifact visualizations.
- `deep-research`: Multi-pass deep research workflow.
- `computer-history`: Local activity history inspection.
- `latex-compile` / `latex-doctor`: TeX project compilation & environment diagnosis.
- `record-and-replay`: Action recording and playback.
- `sites-building` / `sites-hosting`: Website scaffolding & hosting.
- `writing-style`: Document composition style guidelines.

---

## 🔍 Verifying the Installation

After running `npx codex-to-claude`:

1. **Verify MCP servers**:
   ```bash
   claude mcp list
   ```
   You should see `computer-use`, `node_repl`, and `cua_repl` listed and connected.

2. **Verify in Claude Code**:
   Launch Claude Code and test with:
   > "Use computer-use to list all currently open applications on my Mac."

---

## 📄 License

MIT © [cddchen](https://github.com/cddchen)
