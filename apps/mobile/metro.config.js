const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo root so imports from packages work
config.watchFolders = [workspaceRoot];

// Resolve modules from app and workspace root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// 🔒 Prevent Metro from walking up and using parent configs
config.resolver.disableHierarchicalLookup = true;

module.exports = config;

const path = require("path");
