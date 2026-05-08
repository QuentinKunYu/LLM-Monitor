const OpenAI = require('openai');
require('dotenv').config();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, project: process.env.OPENAI_PROJECT_ID || undefined });
async function run() {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo today?' }],
    });
    console.log("Success:", response.choices[0].message.content || response.choices[0].message);
  } catch(e) {
    console.error("Error:", e.message);
  }
}
run();
