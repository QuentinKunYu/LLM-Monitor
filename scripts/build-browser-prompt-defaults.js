const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const projectRoot = path.join(__dirname, '..');
const sourcePath = path.join(projectRoot, 'config', 'needs_based_prompts.csv');
const outputPath = path.join(projectRoot, 'public', 'default-prompts.js');
const rows = parse(fs.readFileSync(sourcePath, 'utf8'), {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

if (rows.length !== 200) {
  throw new Error(`Expected 200 needs-based prompts, found ${rows.length}.`);
}

const output = [
  '/* Generated from config/needs_based_prompts.csv. Do not edit by hand. */',
  `window.DEFAULT_NEEDS_PROMPTS = ${JSON.stringify(rows, null, 2)};`,
  '',
].join('\n');

fs.writeFileSync(outputPath, output, 'utf8');
console.log(`Wrote ${rows.length} browser prompt defaults to ${outputPath}`);
