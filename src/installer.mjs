import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AUTO_APPROVE_PROXY_SOURCE,
  generateMcpServersConfig,
  getEnhancedComputerUseSkillMd,
} from "./generator.mjs";

/**
 * Recursively copy a directory.
 */
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Install the auto-approve proxy script.
 */
export function installProxy(proxyFilePath) {
  const dir = path.dirname(proxyFilePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(proxyFilePath, AUTO_APPROVE_PROXY_SOURCE, {
    encoding: "utf-8",
    mode: 0o755,
  });
  try {
    fs.chmodSync(proxyFilePath, 0o755);
  } catch {}
  return proxyFilePath;
}

/**
 * Install selected skills to the target skills directory.
 */
export function installSkills(selectedSkills, targetSkillsDir, env) {
  fs.mkdirSync(targetSkillsDir, { recursive: true });
  const installed = [];

  for (const skill of selectedSkills) {
    const destSkillDir = path.join(targetSkillsDir, skill.id);
    fs.mkdirSync(destSkillDir, { recursive: true });

    if (skill.id === "computer-use") {
      // 1. Write enhanced SKILL.md
      fs.writeFileSync(
        path.join(destSkillDir, "SKILL.md"),
        getEnhancedComputerUseSkillMd(),
        "utf-8"
      );

      // 2. Preserve original SKILL.md from Codex as backup
      if (skill.skillMd && fs.existsSync(skill.skillMd)) {
        fs.copyFileSync(
          skill.skillMd,
          path.join(destSkillDir, "SKILL.original.md")
        );
      }

      // 3. Copy references if available
      const pluginDir = path.dirname(path.dirname(skill.skillDir));
      const refMd = path.join(
        pluginDir,
        ".codex-plugin/computer-use-node-repl.md"
      );
      const referencesDir = path.join(destSkillDir, "references");
      fs.mkdirSync(referencesDir, { recursive: true });
      if (fs.existsSync(refMd)) {
        fs.copyFileSync(
          refMd,
          path.join(referencesDir, "computer-use-node-repl.md")
        );
      }
    } else {
      // Direct copy of other bundled Codex skills
      if (skill.skillDir && fs.existsSync(skill.skillDir)) {
        copyDirRecursive(skill.skillDir, destSkillDir);
      }
    }

    installed.push({ id: skill.id, name: skill.name, path: destSkillDir });
  }

  return installed;
}

/**
 * Safely merge new MCP servers into an existing config JSON file (or create new).
 */
export function mergeMcpConfig(targetJsonPath, newServers) {
  let configData = {};
  let isNew = true;

  if (fs.existsSync(targetJsonPath)) {
    isNew = false;
    try {
      const raw = fs.readFileSync(targetJsonPath, "utf-8");
      configData = JSON.parse(raw);
      // Backup
      const bakPath = `${targetJsonPath}.bak.${Date.now()}`;
      fs.writeFileSync(bakPath, raw, "utf-8");
    } catch (err) {
      console.warn(
        `[installer] Warning: failed to parse ${targetJsonPath}, creating fresh backup.`
      );
    }
  }

  if (!configData.mcpServers || typeof configData.mcpServers !== "object") {
    configData.mcpServers = {};
  }

  // Merge (new servers overwrite matching keys, leaving others intact)
  for (const [key, val] of Object.entries(newServers)) {
    configData.mcpServers[key] = val;
  }

  const dir = path.dirname(targetJsonPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    targetJsonPath,
    JSON.stringify(configData, null, 2) + "\n",
    "utf-8"
  );

  return { targetJsonPath, isNew, serverCount: Object.keys(newServers).length };
}

/**
 * Execute installation to Claude Code Global environment.
 */
export function installGlobal({ env, enabledServerIds, selectedSkills }) {
  const claudeHome = path.join(os.homedir(), ".claude");
  const globalMcpJsonPath = path.join(os.homedir(), ".claude.json");
  const proxyPath = path.join(claudeHome, "scripts/mcp-auto-approve-proxy.mjs");
  const skillsDir = path.join(claudeHome, "skills");

  // 1. Install Proxy
  installProxy(proxyPath);

  // 2. Generate MCP Server Definitions
  const mcpConfig = generateMcpServersConfig(env, proxyPath, enabledServerIds);

  // 3. Merge MCP to ~/.claude.json
  const mcpResult = mergeMcpConfig(globalMcpJsonPath, mcpConfig);

  // 4. Install Skills to ~/.claude/skills
  const installedSkills = installSkills(selectedSkills, skillsDir, env);

  return {
    scope: "global",
    mcpConfigFile: globalMcpJsonPath,
    mcpServers: Object.keys(mcpConfig),
    proxyFile: proxyPath,
    skillsDir,
    installedSkills,
  };
}

/**
 * Execute installation to Project environment.
 */
export function installProject({
  projectRoot = process.cwd(),
  env,
  enabledServerIds,
  selectedSkills,
}) {
  const projectMcpJsonPath = path.join(projectRoot, ".mcp.json");
  const proxyPath = path.join(projectRoot, "scripts/mcp-auto-approve-proxy.mjs");
  const skillsDir = path.join(projectRoot, ".claude/skills");

  // 1. Install Proxy
  installProxy(proxyPath);

  // 2. Generate MCP Server Definitions
  const mcpConfig = generateMcpServersConfig(env, proxyPath, enabledServerIds);

  // 3. Merge MCP to ./.mcp.json
  const mcpResult = mergeMcpConfig(projectMcpJsonPath, mcpConfig);

  // 4. Install Skills to ./.claude/skills
  const installedSkills = installSkills(selectedSkills, skillsDir, env);

  return {
    scope: "project",
    projectRoot,
    mcpConfigFile: projectMcpJsonPath,
    mcpServers: Object.keys(mcpConfig),
    proxyFile: proxyPath,
    skillsDir,
    installedSkills,
  };
}
