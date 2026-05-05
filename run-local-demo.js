const { execSync } = require("child_process");

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: "inherit" });
}

try {
  console.log("Starting local ads automation demo...");

  run("node test-recommendation.js");
  run("node approve.js 2");
  run("node apply-approved.js");

  console.log("\nLocal demo completed.");
} catch (error) {
  console.error("\nLocal demo failed.");
  process.exit(1);
}