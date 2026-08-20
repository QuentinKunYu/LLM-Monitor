const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const promptTemplate = 'I am looking for a [category]. Return valid JSON only, with this schema: {"brands":["Brand name"]}. Include up to five brand names. Do not include explanations, markdown, numbering, or any text outside the JSON object.';

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not start on port ${port}. Output:\n${output}`));
    }, 10000);

    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(`localhost:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', chunk => {
      output += chunk.toString();
    });
    child.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before ready with code ${code}. Output:\n${output}`));
    });
  });
}

async function startServer(env = {}) {
  const port = String(4100 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: port,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForServer(child, port);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    },
  };
}

function basicAuth(password) {
  return `Basic ${Buffer.from(`user:${password}`).toString('base64')}`;
}

test('APP_PASSWORD protects HTTP endpoints with basic auth', async () => {
  const server = await startServer({ APP_PASSWORD: 'secret' });
  try {
    const unauthenticated = await fetch(`${server.baseUrl}/api/config`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('www-authenticate'), 'Basic realm="LLM Brand Experiment"');

    const authenticated = await fetch(`${server.baseUrl}/api/config`, {
      headers: { Authorization: basicAuth('secret') },
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).categories.length > 0, true);
  } finally {
    await server.stop();
  }
});

test('unified dry run is token-scoped and never persists supplied API keys', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-brand-experiment-'));
  const server = await startServer({ DATA_DIR: dataDir });
  const secretValues = {
    openai: 'never-store-openai-secret',
    google: 'never-store-google-secret',
    anthropic: 'never-store-anthropic-secret',
  };
  const prompts = [
    {
      category: 'Cordless Drills',
      sub_category: 'cordless drills',
      prompt_condition: 'needs-based-general',
      theme: 'basic home use',
      prompt_id: 'test_general_01',
      prompt: 'I need a cordless drill for home repairs. Return valid JSON only, with this schema: {"brands":["Brand name"]}.',
    },
    {
      category: 'Cordless Drills',
      sub_category: 'cordless drills',
      prompt_condition: 'needs-based-detailed',
      theme: 'basic home use',
      prompt_id: 'test_detailed_01',
      prompt: 'I need a cordless drill for occasional apartment repairs. Return valid JSON only, with this schema: {"brands":["Brand name"]}.',
    },
  ];

  try {
    const createResponse = await fetch(`${server.baseUrl}/api/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        models: ['gpt-5.5'],
        categories: ['cordless drills'],
        contextFreeReplicates: 1,
        needsRepeats: 1,
        maxOutputTokens: 800,
        reasonMaxOutputTokens: 800,
        temperature: null,
        followupReasons: true,
        webSearch: false,
        dryRun: true,
        promptTemplate,
        needsPrompts: prompts,
        apiKeys: secretValues,
      }),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.equal(created.counts.recommendationCalls, 3);
    assert.equal(created.counts.reasonCalls, 3);

    const forbidden = await fetch(`${server.baseUrl}/api/experiments/${created.runId}`);
    assert.equal(forbidden.status, 403);

    let status;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(`${server.baseUrl}/api/experiments/${created.runId}`, {
        headers: { 'X-Run-Token': created.runToken },
      });
      status = await response.json();
      if (status.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status.status, 'completed');
    assert.equal(status.completeness.successfulRecommendations, 3);
    assert.equal(status.completeness.completedReasons, 3);

    const resultResponse = await fetch(`${server.baseUrl}/api/experiments/${created.runId}/results`, {
      headers: { 'X-Run-Token': created.runToken },
    });
    const resultText = await resultResponse.text();
    const resultData = JSON.parse(resultText);
    assert.equal(resultData.metrics.length > 0, true);
    assert.equal(resultData.metricsByTheme.length > 0, true);
    for (const secret of Object.values(secretValues)) assert.equal(resultText.includes(secret), false);

    const persisted = fs.readFileSync(path.join(dataDir, 'experiments', `${created.runId}.json`), 'utf8');
    for (const secret of Object.values(secretValues)) assert.equal(persisted.includes(secret), false);
  } finally {
    await server.stop();
  }
});
