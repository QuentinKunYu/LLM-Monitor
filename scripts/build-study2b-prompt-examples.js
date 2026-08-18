const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const outDir = path.join(DATA_DIR, 'exports', 'study2', 'prompt_examples');
const outFile = path.join(outDir, 'study2b_prompt_examples.csv');

const categories = [
  { category: 'power tool', sub_category: 'cordless drills' },
  { category: 'camping/hiking', sub_category: 'hiking jacket' },
];

function loadCSV(filename) {
  return parse(fs.readFileSync(path.join(ROOT, 'config', filename), 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function profileText(persona) {
  return [
    `Persona ID: ${persona.persona_id}`,
    `Age range: ${persona.age_range}`,
    `Gender: ${persona.gender}`,
    `Income range: ${persona.income_range}`,
    `Life stage: ${persona.life_stage}`,
    `Shopping orientation: ${persona.shopping_orientation}`,
    `Category experience: ${persona.category_experience}`,
    `Budget orientation: ${persona.budget_orientation}`,
    `Style identity: ${persona.style_identity}`,
    `Practical needs: ${persona.practical_needs}`,
    `Aspirational goals: ${persona.aspirational_goals}`,
  ].join('\n');
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const personas = loadCSV('synthetic_personas_test.csv');
  const condition = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'prompt_conditions.json'), 'utf8'))
    .conditions.find(item => item.id === 'synthetic-profile');

  const rows = [];
  for (const persona of personas) {
    for (const category of categories) {
      const profile = profileText(persona);
      const prompt = condition.prompt_template
        .replace(/\[profile\]/gi, profile)
        .replace(/\[category\]/gi, category.sub_category);

      rows.push({
        persona_id: persona.persona_id,
        persona_type: 'synthetic_test',
        category: category.category,
        sub_category: category.sub_category,
        prompt_condition: 'synthetic-profile',
        profile_text: profile,
        prompt,
      });
    }
  }

  const headers = ['persona_id', 'persona_type', 'category', 'sub_category', 'prompt_condition', 'profile_text', 'prompt'];
  const body = [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ].join('\n');

  fs.writeFileSync(outFile, `${body}\n`);
  console.log(`Study 2b prompt examples written: ${outFile}`);
  console.log(`Rows: ${rows.length}`);
}

main();
