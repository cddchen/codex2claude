import readline from "node:readline";

export const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

export function banner() {
  console.log(`
${colors.cyan}${colors.bold}╭─────────────────────────────────────────────────────────────╮
│          Codex ➔ Claude Code  MCP & Skills Exporter          │
╰─────────────────────────────────────────────────────────────╯${colors.reset}
`);
}

export function printSection(title) {
  console.log(`\n${colors.bold}${colors.cyan}▶ ${title}${colors.reset}`);
}

export function askQuestion(rl, query, defaultAnswer = "") {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim() || defaultAnswer);
    });
  });
}

export function printEnvSummary(env) {
  printSection("Codex 本地运行环境探测");
  console.log(`  ${colors.dim}ChatGPT 资源路径:${colors.reset} ${env.paths.chatgptResources}`);
  console.log(`  ${colors.dim}Codex Home 路径:${colors.reset}  ${env.paths.codexHome}`);

  console.log(`\n${colors.bold}  可用的 MCP 服务:${colors.reset}`);
  for (const [key, mcp] of Object.entries(env.mcps)) {
    const status = mcp.available
      ? `${colors.green}● 就绪${colors.reset}`
      : `${colors.red}○ 未就绪${colors.reset}`;
    console.log(`   [${status}] ${colors.bold}${key.padEnd(14)}${colors.reset} - ${mcp.description}`);
  }

  console.log(`\n${colors.bold}  已发现的 Codex 内置 Skills (${env.skills.length} 个):${colors.reset}`);
  for (const skill of env.skills) {
    console.log(`   • ${colors.magenta}${skill.id.padEnd(24)}${colors.reset} ${colors.dim}${skill.description.slice(0, 50)}...${colors.reset}`);
  }
}
