const { execSync } = require("child_process");

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: "inherit" });
}

try {
  console.log("Running full local ads automation demo...");

  run("node create-daily-alert.js");
  run("node render-report.js 2026-05-03-main-market");
  run("node approve.js 7");
  run("node apply-approved.js");
  run("node evaluate-impact.js");
  run("node render-impact-report.js");

  console.log("\nFull local demo completed.");
} catch (error) {
  console.error("\nFull local demo failed.");
  process.exit(1);
}
