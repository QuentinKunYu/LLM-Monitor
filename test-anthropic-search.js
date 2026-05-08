const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
async function run() {
  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 300,
      messages: [{ role: 'user', content: 'What is the weather in Tokyo today?' }],
      tools: [{
        type: 'web_search_preview',
        name: 'web_search'
      }]
    });
    console.log("Success:", JSON.stringify(response, null, 2));
  } catch(e) {
    console.error("Error:", e.message);
  }
}
run();
