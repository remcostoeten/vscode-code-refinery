const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index.js');
  const testWorkspace = path.resolve(__dirname, './fixture-workspace');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [testWorkspace, '--disable-extensions']
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
