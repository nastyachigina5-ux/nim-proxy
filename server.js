const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'meta/llama-3.1-8b-instruct',
  'gpt-4': 'meta/llama-3.1-70b-instruct',
  'gpt-4-turbo': 'meta/llama-3.1-405b-instruct',
  'gpt-4o': 'meta/llama-3.3-70b-instruct',
  'claude-3-opus': 'deepseek-ai/deepseek-v3.1-terminus',
  'claude-3-sonnet': 'mistralai/mistral-large-2-instruct',
  'gemini-pro': 'google/gemma-3-27b-it'
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-8b-instruct';

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 2048,
      stream: stream || false
    };

    if (ENABLE_THINKING_MODE) {
      nimRequest.extra_body = { chat_template_kwargs: { thinking: true } };
    }

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) { res.write(line + '\n'); return; }
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const content = data.choices[0].delta.content || '';
                const reasoning = data.choices[0].delta.reasoning_content;
                if (SHOW_REASONING && reasoning) {
                  data.choices[0].delta.content = content + reasoning;
                } else {
                  data.choices[0].delta.content = content;
                }
                delete data.choices[0].delta.reasoning_content;
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) { res.write(line + '\n'); }
          }
        });
      });
      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
    } else {
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => ({
          index: choice.index,
          message: {
            role: choice.message.role,
            content: SHOW_REASONING && choice.message.reasoning_content
              ? `<think>\n${choice.message.reasoning_content}\n</think>\n\n${choice.message.content || ''}`
              : choice.message.content || ''
          },
          finish_reason: choice.finish_reason
        })),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      res.json(openaiResponse);
    }
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: { message: error.message || 'Internal server error', type: 'proxy_error' }
    });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found` } });
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
