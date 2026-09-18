import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Parses basic YAML frontmatter from markdown content.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return meta;
}

/**
 * Recursively find a file with a given filename within directory up to maxDepth.
 */
function findFile(dir, fileName, maxDepth = 4, currentDepth = 0) {
  if (currentDepth > maxDepth || !fs.existsSync(dir)) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const found = findFile(fullPath, fileName, maxDepth, currentDepth + 1);
        if (found) return found;
      }
    }
  } catch {
    // Ignore permission or read errors
  }
  return null;
}

/**
 * Scan for skills in the Codex plugins directory.
 */
function scanSkills(pluginsDir) {
  const skills = [];
  if (!fs.existsSync(pluginsDir)) return skills;

  try {
    const plugins = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const skillsFolder = path.join(pluginsDir, plugin.name, "skills");
      if (!fs.existsSync(skillsFolder)) continue;

      const skillEntries = fs.readdirSync(skillsFolder, { withFileTypes: true });
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(skillsFolder, entry.name);
        const skillMd = path.join(skillDir, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, "utf-8");
          const meta = parseFrontmatter(content);
          skills.push({
            id: entry.name,
            name: meta.name || entry.name,
            description: meta.description || "Codex built-in skill",
            plugin: plugin.name,
            skillDir,
            skillMd,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[detector] Error scanning skills: ${err.message}`);
  }

  return skills;
}

/**
 * Scan ~/.codex/config.toml to inspect configured MCP servers.
 */
function parseCodexConfigToml(tomlPath) {
  const servers = {};
  if (!fs.existsSync(tomlPath)) return servers;
  try {
    const content = fs.readFileSync(tomlPath, "utf-8");
    const mcpRegex = /\[mcp_servers\.([a-zA-Z0-9_-]+)\]/g;
    let match;
    while ((match = mcpRegex.exec(content)) !== null) {
      const serverName = match[1];
      servers[serverName] = { name: serverName, definedInToml: true };
    }
  } catch {}
  return servers;
}

/**
 * Detect all Codex resources and available MCPs/Skills.
 */
export function detectCodexEnv(options = {}) {
  const chatgptResources =
    options.chatgptResources ||
    process.env.CHATGPT_RESOURCES ||
    "/Applications/ChatGPT.app/Contents/Resources";

  const codexHome =
    options.codexHome ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex");

  const skyClientCandidate = path.join(
    codexHome,
    "computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
  );

  const skyCuaServiceCandidate = path.join(
    codexHome,
    "computer-use/Codex Computer Use.app"
  );

  const nodeBin = path.join(chatgptResources, "cua_node/bin/node");
  const nodeReplBin = path.join(chatgptResources, "cua_node/bin/node_repl");
  const cuaReplScript = path.join(
    chatgptResources,
    "cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs"
  );
  const nodeModulesDir = path.join(chatgptResources, "cua_node/lib/node_modules");
  const codexCli = path.join(chatgptResources, "codex");
  const pluginsDir = path.join(chatgptResources, "plugins/openai-bundled/plugins");

  // Find browser-service.mjs
  let browserService = null;
  const browserCacheDir = path.join(codexHome, "plugins/cache/openai-bundled/browser");
  if (fs.existsSync(browserCacheDir)) {
    browserService = findFile(browserCacheDir, "browser-service.mjs", 4);
  }
  if (!browserService) {
    const bundledBrowserDir = path.join(pluginsDir, "browser");
    if (fs.existsSync(bundledBrowserDir)) {
      browserService = findFile(bundledBrowserDir, "browser-service.mjs", 3);
    }
  }

  // Check which MCPs are ready
  const mcpServers = {
    "computer-use": {
      id: "computer-use",
      name: "Computer Use (macOS Native GUI)",
      available: fs.existsSync(skyClientCandidate),
      command: skyClientCandidate,
      description: "Direct desktop UI actions: click, type, screenshot, inspect AX tree",
    },
    "node_repl": {
      id: "node_repl",
      name: "Node REPL Sandbox Engine",
      available: fs.existsSync(nodeReplBin) && fs.existsSync(nodeBin),
      command: nodeReplBin,
      description: "Persistent JS execution engine with top-level await and @oai/sky bridge",
    },
    "cua_repl": {
      id: "cua_repl",
      name: "CUA REPL (Unified Computer Use Agent)",
      available: fs.existsSync(cuaReplScript) && fs.existsSync(nodeBin),
      command: nodeBin,
      script: cuaReplScript,
      description: "High-level UI & browser automation runtime with pre-injected global cua object",
    },
  };

  const skills = scanSkills(pluginsDir);
  const tomlServers = parseCodexConfigToml(path.join(codexHome, "config.toml"));

  return {
    paths: {
      chatgptResources,
      codexHome,
      skyClientBin: skyClientCandidate,
      skyCuaServicePath: skyCuaServiceCandidate,
      nodeBin,
      nodeReplBin,
      cuaReplScript,
      nodeModulesDir,
      codexCli,
      pluginsDir,
      browserService:
        browserService ||
        path.join(pluginsDir, "browser/scripts/browser-service.mjs"),
    },
    mcps: mcpServers,
    skills,
    tomlServers,
    isCodexInstalled:
      fs.existsSync(chatgptResources) || fs.existsSync(codexHome),
  };
}
