#!/usr/bin/env node

import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { detectCodexEnv } from "../src/detector.mjs";
import { installGlobal, installProject } from "../src/installer.mjs";
import { generateMcpServersConfig } from "../src/generator.mjs";
import {
  banner,
  colors,
  printSection,
  askQuestion,
  printEnvSummary,
} from "../src/ui.mjs";

function parseArgs(args) {
  const flags = {
    help: false,
    global: false,
    project: false,
    both: false,
    dryRun: false,
    yes: false,
    allSkills: false,
    chatgptResources: null,
    codexHome: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "-g" || arg === "--global") flags.global = true;
    else if (arg === "-p" || arg === "--project") flags.project = true;
    else if (arg === "-b" || arg === "--both") flags.both = true;
    else if (arg === "-d" || arg === "--dry-run") flags.dryRun = true;
    else if (arg === "-y" || arg === "--yes") flags.yes = true;
    else if (arg === "--all-skills") flags.allSkills = true;
    else if (arg === "--chatgpt-path" && args[i + 1]) {
      flags.chatgptResources = args[++i];
    } else if (arg === "--codex-home" && args[i + 1]) {
      flags.codexHome = args[++i];
    }
  }
  return flags;
}

function printHelp() {
  console.log(`
${colors.bold}codex-to-claude${colors.reset} - 导出 Codex 内置 MCP 服务与 Skill 到 Claude Code

${colors.bold}用法:${colors.reset}
  npx codex-to-claude [选项]
  node ./bin/cli.mjs [选项]

${colors.bold}选项:${colors.reset}
  -g, --global           直接安装到全局配置 (~/.claude.json 与 ~/.claude/skills/)
  -p, --project          直接安装到当前工作区项目 (./.mcp.json 与 ./.claude/skills/)
  -b, --both             同时安装到全局与当前项目
  -d, --dry-run          仅检测并预览配置，不修改任何文件
  -y, --yes              非交互模式，全部使用推荐选项
      --all-skills       安装发现的全部 Codex 技能（默认仅安装 computer-use）
      --chatgpt-path <p> 指定 ChatGPT.app Resources 绝对路径
      --codex-home <p>   指定 Codex 配置与缓存主目录 (~/.codex)
  -h, --help             显示帮助信息
`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  banner();

  // 1. Detect Codex Environment
  const env = detectCodexEnv({
    chatgptResources: flags.chatgptResources,
    codexHome: flags.codexHome,
  });

  if (!env.isCodexInstalled) {
    console.error(
      `${colors.red}❌ 未在当前机器检测到 ChatGPT.app 或 ~/.codex 安装。${colors.reset}`
    );
    console.error(
      `请确认本台 Mac 已安装 ChatGPT 桌面版或通过 --chatgpt-path 指定路径。`
    );
    process.exit(1);
  }

  printEnvSummary(env);

  let targetChoice = "1";
  let mcpChoice = "1";
  let skillChoice = "1";

  const isInteractive = !flags.global && !flags.project && !flags.both && !flags.dryRun && !flags.yes;

  if (isInteractive) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    printSection("配置安装选项");

    // Question 1: Target Destination
    console.log(`\n${colors.bold}1. 您希望将 MCP 和 Skill 安装到哪里？${colors.reset}`);
    console.log(`  ${colors.green}[1]${colors.reset} Claude Code 全局配置 (推荐: ~/.claude.json & ~/.claude/skills/)`);
    console.log(`  ${colors.green}[2]${colors.reset} 当前项目 (Project: ./.mcp.json & ./.claude/skills/)`);
    console.log(`  ${colors.green}[3]${colors.reset} 全局与当前项目同时配置 (Both)`);
    console.log(`  ${colors.green}[4]${colors.reset} 仅生成预览 (Dry Run，不写入任何文件)`);
    targetChoice = await askQuestion(rl, `请选择 [1/2/3/4] (默认 1): `, "1");

    if (targetChoice !== "4") {
      // Question 2: MCP Selection
      console.log(`\n${colors.bold}2. 选择要启用的 MCP 服务通道：${colors.reset}`);
      console.log(`  ${colors.green}[1]${colors.reset} 全部推荐通道 (cua_repl + node_repl + computer-use，已内置自动放行代理) [默认推荐]`);
      console.log(`  ${colors.green}[2]${colors.reset} 仅启用 cua_repl (高阶批处理，配合 computer-use 技能最佳体验)`);
      console.log(`  ${colors.green}[3]${colors.reset} 仅启用 computer-use (macOS 原生单步原子工具)`);
      mcpChoice = await askQuestion(rl, `请选择 [1/2/3] (默认 1): `, "1");

      // Question 3: Skill Selection
      console.log(`\n${colors.bold}3. 选择要导出的技能 (Skills)：${colors.reset}`);
      console.log(`  ${colors.green}[1]${colors.reset} 仅导出 computer-use 自动化技能 [默认推荐]`);
      console.log(`  ${colors.green}[2]${colors.reset} 导出全部已发现的 Codex 技能 (共 ${env.skills.length} 个)`);
      skillChoice = await askQuestion(rl, `请选择 [1/2] (默认 1): `, "1");
    }

    rl.close();
  } else {
    // Non-interactive flags
    if (flags.dryRun) targetChoice = "4";
    else if (flags.both) targetChoice = "3";
    else if (flags.project) targetChoice = "2";
    else targetChoice = "1";

    skillChoice = flags.allSkills ? "2" : "1";
  }

  // Parse enabled MCPs
  let enabledServerIds = ["computer-use", "node_repl", "cua_repl"];
  if (mcpChoice === "2") enabledServerIds = ["cua_repl"];
  if (mcpChoice === "3") enabledServerIds = ["computer-use"];

  // Parse selected skills
  let selectedSkills = [];
  if (skillChoice === "2") {
    selectedSkills = env.skills;
  } else {
    const compUseSkill = env.skills.find((s) => s.id === "computer-use");
    if (compUseSkill) {
      selectedSkills = [compUseSkill];
    } else {
      selectedSkills = [
        {
          id: "computer-use",
          name: "computer-use",
          description: "Control local Mac apps through Computer Use",
        },
      ];
    }
  }

  // Handle Dry Run
  if (targetChoice === "4") {
    printSection("Dry Run 预览输出");
    const previewMcp = generateMcpServersConfig(
      env,
      path.join(os.homedir(), ".claude/scripts/mcp-auto-approve-proxy.mjs"),
      enabledServerIds
    );
    console.log(`\n${colors.bold}拟写入的 mcpServers JSON:${colors.reset}`);
    console.log(JSON.stringify(previewMcp, null, 2));
    console.log(`\n${colors.bold}拟导出的 Skills:${colors.reset}`);
    for (const s of selectedSkills) {
      console.log(` - ${s.id} (${s.name})`);
    }
    console.log(`\n${colors.green}✔ Dry Run 完成，未对磁盘做任何修改。${colors.reset}`);
    process.exit(0);
  }

  // Execute Installations
  const results = [];

  if (targetChoice === "1" || targetChoice === "3") {
    printSection("正在部署到 Claude Code 全局环境...");
    const globalRes = installGlobal({
      env,
      enabledServerIds,
      selectedSkills,
    });
    results.push(globalRes);
  }

  if (targetChoice === "2" || targetChoice === "3") {
    printSection("正在部署到当前项目环境...");
    const projectRes = installProject({
      projectRoot: process.cwd(),
      env,
      enabledServerIds,
      selectedSkills,
    });
    results.push(projectRes);
  }

  // Print Final Report
  printSection("部署完成报告");
  for (const res of results) {
    console.log(`\n${colors.bold}${colors.green}✔ 已成功安装到 [${res.scope.toUpperCase()}] 环境:${colors.reset}`);
    console.log(`  • MCP 配置文件:   ${colors.cyan}${res.mcpConfigFile}${colors.reset}`);
    console.log(`  • 已激活 MCP 服务: ${colors.yellow}${res.mcpServers.join(", ")}${colors.reset}`);
    console.log(`  • 自动放行代理:   ${colors.cyan}${res.proxyFile}${colors.reset}`);
    console.log(`  • Skills 技能目录: ${colors.cyan}${res.skillsDir}${colors.reset}`);
    console.log(`  • 已同步的技能:   ${colors.magenta}${res.installedSkills.map((s) => s.id).join(", ")}${colors.reset}`);
  }

  console.log(`
${colors.bold}${colors.cyan}💡 后续使用提示:${colors.reset}
  1. 打开终端运行 ${colors.bold}claude${colors.reset}，即可直接使用已注册的 Codex MCP 服务与技能。
  2. 验证 MCP 是否生效：在 Claude Code 中输入 ${colors.bold}/mcp${colors.reset} 或通过 CLI 运行 ${colors.bold}claude mcp list${colors.reset}。
  3. 执行 UI 自动化：直接指示 Claude ${colors.bold}"使用 computer-use 查看当前打开的 App"${colors.reset} 即可！
`);
}

main().catch((err) => {
  console.error(`${colors.red}\n执行失败: ${err.message}${colors.reset}`);
  console.error(err.stack);
  process.exit(1);
});
