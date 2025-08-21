/**
 * Metro configuration for Expo in a monorepo.
 * Minimizes watched files to avoid EMFILE on macOS.
 * Docs: https://docs.expo.dev/guides/monorepos/
 */
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Only watch shared packages that the mobile app imports.
const sharedPackages = [
  'packages/utils',
];

config.watchFolders = sharedPackages.map((p) => path.resolve(monorepoRoot, p));

// Resolve node_modules from the app and the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

module.exports = config;
