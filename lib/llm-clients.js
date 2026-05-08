/**
 * LLM Client Module
 * ─────────────────
 * Provides a unified interface for sending context-free prompts to
 * OpenAI, Anthropic, and Google Gemini models.
 *
 * METHODOLOGICAL RULE: Each call is stateless — no conversation history
 * is maintained between replicates to ensure independence.
 */

const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── OpenAI ──────────────────────────────────────────────────────────
async function callOpenAI(prompt, modelName, temperature, maxTokens, webSearch) {
  const clientOptions = { apiKey: process.env.OPENAI_API_KEY };
  // If using a project-scoped key (sk-proj-...), include the project ID
  if (process.env.OPENAI_PROJECT_ID) {
    clientOptions.project = process.env.OPENAI_PROJECT_ID;
  }
  const client = new OpenAI(clientOptions);
  
  const finalModelName = modelName;

  if (finalModelName.startsWith('gpt-5')) {
    const response = await client.responses.create({
      model: finalModelName,
      input: prompt,
      ...(webSearch ? { tools: [{ type: 'web_search_preview' }] } : {}),
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      max_output_tokens: maxTokens,
    });
    return response.output_text || '';
  }

  const tokenLimitParam = finalModelName.startsWith('gpt-5')
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  const temperatureParam = finalModelName.startsWith('gpt-5.5')
    ? {}
    : { temperature };

  const response = await client.chat.completions.create({
    model: finalModelName,
    messages: [{ role: 'user', content: prompt }],   // single-turn, no history
    ...temperatureParam,
    ...tokenLimitParam,
  });
  return response.choices[0].message.content;
}

// ── Anthropic ───────────────────────────────────────────────────────
async function callAnthropic(prompt, modelName, temperature, maxTokens, webSearch) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const options = {
    model: modelName,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],   // single-turn, no history
  };

  // Some newest Claude models reject sampling controls such as temperature.
  // Keep temperature for models that accept it so existing runs stay comparable.
  if (!modelName.includes('opus-4-7')) {
    options.temperature = temperature;
  }

  if (webSearch) {
    options.tools = [{ type: 'web_search_20260209', name: 'web_search' }];
  }

  const response = await client.messages.create(options);
  
  // Extract all text blocks
  let content = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      content += block.text;
    }
  }
  return content;
}

// ── Google Gemini ───────────────────────────────────────────────────
async function callGoogle(prompt, modelName, temperature, maxTokens, webSearch) {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  
  const options = {
    model: modelName,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };
  
  if (webSearch) {
    options.tools = [{ googleSearch: {} }];
  }

  const model = genAI.getGenerativeModel(options);
  const result = await model.generateContent(prompt);  // single-turn
  return result.response.text();
}

// ── Unified dispatcher ─────────────────────────────────────────────
/**
 * Send a single context-free prompt to the specified provider.
 * Returns the raw response text.
 *
 * @param {string} provider   - "openai" | "anthropic" | "google"
 * @param {string} modelName  - exact model identifier
 * @param {string} prompt     - the fully-formed prompt (category already substituted)
 * @param {number} temperature
 * @param {number} maxTokens
 * @param {boolean} webSearch - whether to enable web search / tools
 * @returns {Promise<string>} raw LLM response text
 */
async function sendPrompt(provider, modelName, prompt, temperature, maxTokens, webSearch = false) {
  switch (provider.toLowerCase()) {
    case 'openai':
      return callOpenAI(prompt, modelName, temperature, maxTokens, webSearch);
    case 'anthropic':
      return callAnthropic(prompt, modelName, temperature, maxTokens, webSearch);
    case 'google':
      return callGoogle(prompt, modelName, temperature, maxTokens, webSearch);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

module.exports = { sendPrompt };
