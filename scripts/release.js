#!/usr/bin/env node
/**
 * @fileoverview Automated release script for VS Code extension
 * @description Handles version bumping, building, and publishing to GitHub and VS Code Marketplace
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * @typedef {Object} TReleaseOptions
 * @property {boolean} dryRun - Whether to perform a dry run without making actual changes
 * @property {boolean} skipGithub - Whether to skip GitHub release
 * @property {boolean} skipMarketplace - Whether to skip VS Code Marketplace release
 */

/**
 * @type {TReleaseOptions}
 */
const defaultOptions = {
  dryRun: false,
  skipGithub: false,
  skipMarketplace: false
};

/**
 * Executes a shell command and returns the output
 * @param {string} command - Command to execute
 * @param {boolean} silent - Whether to suppress console output
 * @returns {string} Command output
 */
function executeCommand(command, silent = false) {
  try {
    if (!silent) {
      console.log(`Executing: ${command}`);
    }
    
    if (options.dryRun && !command.startsWith('git status') && !command.startsWith('npm view')) {
      console.log(`[DRY RUN] Would execute: ${command}`);
      return '';
    }
    
    return execSync(command, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' });
  } catch (error) {
    console.error(`Error executing command: ${command}`);
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * Bumps the version in package.json by 0.01
 * @returns {string} New version number
 */
function bumpVersion() {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  // Parse current version
  const versionParts = packageJson.version.split('.');
  if (versionParts.length !== 3) {
    console.error('Invalid version format in package.json. Expected format: X.Y.Z');
    process.exit(1);
  }
  
  // Extract major, minor, patch
  const major = parseInt(versionParts[0], 10);
  let minor = parseFloat(versionParts[1], 10);
  const patch = parseInt(versionParts[2], 10);
  
  // Add 0.01 to minor version
  minor = minor + 0.01;
  
  // Format new version
  const newVersion = `${major}.${minor.toFixed(2).replace(/\.00$/, '.0')}.${patch}`;
  
  console.log(`Bumping version from ${packageJson.version} to ${newVersion}`);
  
  if (!options.dryRun) {
    packageJson.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  }
  
  return newVersion;
}

/**
 * Builds the extension
 */
function buildExtension() {
  console.log('Building extension...');
  executeCommand('npm run compile');
}

/**
 * Packages the extension into a VSIX file
 * @param {string} version - Version number
 * @returns {string} Path to the generated VSIX file
 */
function packageExtension(version) {
  console.log('Packaging extension...');
  executeCommand('npx vsce package');
  
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  return `${packageJson.name}-${version}.vsix`;
}

/**
 * Commits and pushes changes to GitHub
 * @param {string} version - Version number
 */
function commitAndPushToGithub(version) {
  if (options.skipGithub) {
    console.log('Skipping GitHub release...');
    return;
  }
  
  console.log('Committing changes...');
  executeCommand('git add package.json');
  executeCommand(`git commit -m "Bump version to ${version}"`);
  
  console.log('Creating git tag...');
  executeCommand(`git tag v${version}`);
  
  console.log('Pushing to GitHub...');
  executeCommand('git push');
  executeCommand('git push --tags');
}

/**
 * Publishes the extension to VS Code Marketplace
 */
function publishToMarketplace() {
  if (options.skipMarketplace) {
    console.log('Skipping VS Code Marketplace release...');
    return;
  }
  
  console.log('Publishing to VS Code Marketplace...');
  
  // Check if VSCE_PAT environment variable is set
  if (!process.env.VSCE_PAT && !options.dryRun) {
    console.error('VSCE_PAT environment variable is not set. Please set it to your Personal Access Token.');
    process.exit(1);
  }
  
  executeCommand('npx vsce publish');
}

/**
 * Parses command line arguments
 * @returns {TReleaseOptions} Parsed options
 */
function parseArguments() {
  const args = process.argv.slice(2);
  const options = { ...defaultOptions };
  
  for (const arg of args) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--skip-github') {
      options.skipGithub = true;
    } else if (arg === '--skip-marketplace') {
      options.skipMarketplace = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }
  }
  
  return options;
}

/**
 * Shows help information
 */
function showHelp() {
  console.log(`
Release Script for VS Code Extension

Usage:
  node scripts/release.js [options]

Options:
  --dry-run            Perform a dry run without making actual changes
  --skip-github        Skip GitHub release
  --skip-marketplace   Skip VS Code Marketplace release
  --help, -h           Show this help message
  `);
}

/**
 * Validates the environment before release
 */
function validateEnvironment() {
  // Check if git is installed
  try {
    executeCommand('git --version', true);
  } catch (error) {
    console.error('Git is not installed or not in PATH');
    process.exit(1);
  }
  
  // Check if npm is installed
  try {
    executeCommand('npm --version', true);
  } catch (error) {
    console.error('npm is not installed or not in PATH');
    process.exit(1);
  }
  
  // Check if vsce is installed
  try {
    executeCommand('npx vsce --version', true);
  } catch (error) {
    console.error('vsce is not installed. Make sure it\'s in your devDependencies');
    process.exit(1);
  }
  
  // Check if working directory is clean
  const status = executeCommand('git status --porcelain', true);
  if (status.trim() !== '' && !options.dryRun) {
    console.error('Working directory is not clean. Please commit or stash your changes before releasing.');
    process.exit(1);
  }
}

// Main execution
const options = parseArguments();

if (options.dryRun) {
  console.log('Performing dry run - no actual changes will be made');
}

validateEnvironment();
const newVersion = bumpVersion();
buildExtension();
const vsixPath = packageExtension(newVersion);
commitAndPushToGithub(newVersion);
publishToMarketplace();

console.log(`\n✅ Release ${newVersion} completed successfully!`);
if (!options.skipMarketplace) {
  console.log(`Extension published to VS Code Marketplace`);
}
if (!options.skipGithub) {
  console.log(`Changes pushed to GitHub with tag v${newVersion}`);
}
console.log(`VSIX file created at: ${vsixPath}`);
