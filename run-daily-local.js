const { execSync } = require("child_process");

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: "inherit" });
}

try {
  console.log("Running local daily ads alert...");

  run("node create-daily-alert.js");
  run("node render-report.js");

  console.log("\nLocal daily alert completed.");
} catch (error) {
  console.error("\nLocal daily alert failed.");
  process.exit(1);
}