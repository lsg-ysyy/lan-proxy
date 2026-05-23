#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXE_NAME = 'lan-proxy.exe';

console.log('Building LAN Proxy Forwarder...\n');

// Step 1: Bundle all modules into a single file
console.log('[1/5] Bundling source files...');
execSync('npx esbuild src/main.js --bundle --platform=node --outfile=dist/bundle.js --format=cjs', {
  cwd: ROOT,
  stdio: 'inherit',
});

// Step 2: Generate SEA blob
console.log('[2/5] Generating SEA blob...');
execSync('node --experimental-sea-config sea-config.json', {
  cwd: ROOT,
  stdio: 'inherit',
});

// Step 3: Copy node.exe
console.log('[3/5] Copying Node.js binary...');
const exePath = path.join(ROOT, EXE_NAME);
fs.copyFileSync(process.execPath, exePath);

// Step 4: Remove signature (Windows)
console.log('[4/5] Removing signature...');
try {
  execSync(`signtool remove /s "${exePath}"`, { stdio: 'pipe' });
  console.log('  Signature removed.');
} catch {
  console.log('  signtool not found, will attempt injection anyway.');
}

// Step 5: Inject blob
console.log('[5/5] Injecting SEA blob...');
const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
execSync(
  `npx postject lan-proxy.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse ${sentinelFuse}`,
  { cwd: ROOT, stdio: 'inherit' }
);

// Cleanup
fs.unlinkSync(path.join(ROOT, 'sea-prep.blob'));

const sizeMB = (fs.statSync(exePath).size / 1048576).toFixed(1);
console.log(`\nDone! Output: ${EXE_NAME} (${sizeMB} MB)`);
console.log(`Run: .\\${EXE_NAME} --help`);