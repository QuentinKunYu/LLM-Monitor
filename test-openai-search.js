const OpenAI = require('openai');
require('dotenv').config();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function run() {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo today?' }],
      tools: [{ type: 'web_search_preview' }]
    });
    console.log("Success:", response.choices[0].message.content || response.choices[0].message);
  } catch(e) {
    console.error("Error:", e.message);
  }
}
run();
