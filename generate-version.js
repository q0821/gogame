#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');

function getShortSha() {
  const envSha = process.env.CF_PAGES_COMMIT_SHA || process.env.CF_COMMIT_SHA || process.env.GITHUB_SHA || '';
  if (envSha) return envSha.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (_) {
    return 'dev';
  }
}

const shortSha = getShortSha();
const now = new Date();
const yyyy = now.getUTCFullYear();
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const dd = String(now.getUTCDate()).padStart(2, '0');
const version = `v${yyyy}.${mm}.${dd}-${shortSha}`;
const payload = {
  version,
  updatedAt: now.toISOString(),
  commit: shortSha
};
fs.writeFileSync('version.json', JSON.stringify(payload, null, 2) + '\n');
console.log(version);
