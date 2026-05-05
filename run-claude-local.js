const { execSync } = require("child_process");

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: "inherit" });
}

try {
  console.log("Running Claude local daily ads alert...");

  run("node generate-with-claude.js");
  run("node render-report.js 2026-05-03-main-market-claude");

  console.log("\nClaude local daily alert completed.");
} catch (error) {
  console.error("\nClaude local daily alert failed.");
  process.exit(1);
}