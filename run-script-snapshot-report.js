const { execSync } = require("child_process");

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: "inherit" });
}

try {
  console.log("Generating report from latest Google Ads Script snapshot...");

  run("node generate-from-latest-snapshot.js");
  run("node render-latest-report.js");

  console.log("\nSnapshot report generation completed.");
} catch (error) {
  console.error("\nSnapshot report generation failed.");
  process.exit(1);
}