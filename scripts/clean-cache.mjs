#!/usr/bin/env node

/**
 * Build cache cleaning script for Spring Mouse
 * Removes large cache directories to prevent disk space bloat
 * and maintain optimal build performance.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Directories to clean up (relative to project root)
const CLEAN_DIRS = [
  '.next/dev',      // Turbopack dev cache (largest offender, ~3.1GB)
  '.next/cache',    // Webpack cache (~713MB)
  'node_modules/.cache', // Node.js cache
];

// Additional aggressive clean options
const AGGRESSIVE_CLEAN_DIRS = [
  '.next',
  'node_modules',
];

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const stat = fs.statSync(dirPath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileStat = fs.statSync(filePath);
        if (fileStat.isDirectory()) {
          totalSize += getDirSize(filePath);
        } else {
          totalSize += fileStat.size;
        }
      }
    } else {
      totalSize = stat.size;
    }
  } catch (err) {
    // Directory doesn't exist or inaccessible
    return 0;
  }
  return totalSize;
}

function cleanDirectory(dirPath, aggressive = false) {
  const fullPath = path.resolve(projectRoot, dirPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`  ✓ ${dirPath} (doesn't exist, skipping)`);
    return 0;
  }

  const sizeBefore = getDirSize(fullPath);
  try {
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`  ✓ ${dirPath} (cleaned ${formatSize(sizeBefore)})`);
    return sizeBefore;
  } catch (err) {
    console.log(`  ✗ ${dirPath} (failed: ${err.message})`);
    return 0;
  }
}

function main() {
  const args = process.argv.slice(2);
  const aggressive = args.includes('--aggressive') || args.includes('-a');

  console.log('🧹 Spring Mouse Build Cache Cleaner');
  console.log('=====================================\n');

  if (aggressive) {
    console.log('🔥 Aggressive clean mode - removing .next and node_modules\n');
    const dirsToClean = AGGRESSIVE_CLEAN_DIRS;
    let totalCleaned = 0;
    for (const dir of dirsToClean) {
      totalCleaned += cleanDirectory(dir, true);
    }
    console.log(`\n📊 Total space reclaimed: ${formatSize(totalCleaned)}`);
    console.log('\n💡 Run npm install && npm run build to restore dependencies and build.');
  } else {
    console.log('🧹 Standard clean mode - removing build caches only\n');
    console.log('💡 Use --aggressive flag to also remove .next and node_modules\n');
    const dirsToClean = CLEAN_DIRS;
    let totalCleaned = 0;
    for (const dir of dirsToClean) {
      totalCleaned += cleanDirectory(dir, false);
    }
    console.log(`\n📊 Total space reclaimed: ${formatSize(totalCleaned)}`);
  }

  console.log('\n✨ Cache cleanup completed!');
}

main();
