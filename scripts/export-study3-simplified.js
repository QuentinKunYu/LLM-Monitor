const fs = require('fs');
const path = require('path');
const { exportSimplifiedResults } = require('../lib/simplified-export');

const ROOT = path.join(__dirname, '..');
const STUDY3_EXPORTS = path.join(ROOT, 'data', 'exports', 'study3');

function findLatestRunDir() {
  const candidates = fs.readdirSync(STUDY3_EXPORTS, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.includes('with_reasons'))
    .map(entry => path.join(STUDY3_EXPORTS, entry.name))
    .filter(dir => (
      fs.existsSync(path.join(dir, 'raw_results_cleaned.csv'))
      || fs.existsSync(path.join(dir, 'raw_results.csv'))
    ))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (!candidates.length) {
    throw new Error(`No Study 3 with-reasons run found in ${STUDY3_EXPORTS}`);
  }
  return candidates[0];
}

const runDir = path.resolve(process.argv[2] || findLatestRunDir());
const result = exportSimplifiedResults({ runDir, study: 'study3' });
console.log(JSON.stringify(result, null, 2));
