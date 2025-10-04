const CharacterAI = require('node_characterai');
const chromium = require('chrome-aws-lambda');
const { v4: uuidv4 } = require('uuid');

// Кэш для хранения клиентов
const clientCache = new Map();
const chatCache = new Map();

// Установка CORS заголовков
const setCorsHeaders = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
};

// Получение или создание клиента
async function getOrCreateClient(token) {
  const cacheKey = `client_${token}`;
  
  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }
  
  const client = new CharacterAI();
  
  // Настройка puppeteer для Vercel
  client.puppeteerPath = await chromium.executablePath;
  client.puppeteerLaunchArgs = chromium.args;
  
  try {
    await client.authenticateWithToken(token);
    clientCache.set(cacheKey, client);
    
    // Очистка кэша через 30 минут
    setTimeout(() => {
      clientCache.delete(cacheKey);
    }, 30 * 60 * 1000);
    
    return client;
  } catch (error) {
    console.error('Authentication error:', error);
    throw new Error('Failed to authenticate with Character.AI');
  }
}

// Получение или создание чата
async function getOrCreateChat(client, characterId, token) {
  const cacheKey = `chat_${token}_${characterId}`;
  
  if (chatCache.has(cacheKey)) {
    return chatCache.get(cacheKey);
  }
  
  try {
    const chat = await client.createOrContinueChat(characterId);
    chatCache.set(cacheKey, chat);
    
    // Очистка кэша через 15 минут
    setTimeout(() => {
      chatCache.delete(cacheKey);
    }, 15 * 60 * 1000);
    
    return chat;
  } catch (error) {
    console.error('Chat creation error:', error);
    throw new Error('Failed to create or continue chat');
  }
}

// Парсинг модели для получения ID персонажа
function parseModelId(model) {
  // Формат: "character-ai:{character_id}"
  if (model.startsWith('character-ai:')) {
    return model.substring('character-ai:'.length);
  }
  // Если передан просто ID
  return model;
}

// Основной обработчик
module.exports = async (req, res) => {
  setCorsHeaders(res);
  
  // Обработка preflight запроса
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ 
        error: {
          message: 'Missing or invalid authorization header',
          type: 'invalid_request_error'
        }
      });
      return;
    }
    
    const token = authHeader.substring('Bearer '.length);
    const body = req.body;
    
    // Валидация тела запроса
    if (!body.model || !body.messages) {
      res.status(400).json({ 
        error: {
          message: 'Missing required fields: model or messages',
          type: 'invalid_request_error'
        }
      });
      return;
    }
    
    const characterId = parseModelId(body.model);
    const messages = body.messages;
    const stream = body.stream || false;
    
    // Получение последнего сообщения пользователя
    const userMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    
    if (!userMessage) {
      res.status(400).json({ 
        error: {
          message: 'No user message found',
          type: 'invalid_request_error'
        }
      });
      return;
    }
    
    // Создание клиента и чата
    const client = await getOrCreateClient(token);
    const chat = await getOrCreateChat(client, characterId, token);
    
    // Отправка сообщения и получение ответа
    const response = await chat.sendAndAwaitResponse(userMessage.content, true);
    
    // Формирование ответа в формате OpenAI
    const completionId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);
    
    if (stream) {
      // Streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Отправка начального чанка
      const streamChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: created,
        model: body.model,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: response
          },
          finish_reason: null
        }]
      };
      
      res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
      
      // Отправка финального чанка
      const finalChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: created,
        model: body.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      };
      
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Regular response
      const completion = {
        id: completionId,
        object: 'chat.completion',
        created: created,
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: response
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: userMessage.content.length,
          completion_tokens: response.length,
          total_tokens: userMessage.content.length + response.length
        }
      };
      
      res.status(200).json(completion);
    }
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error'
      }
    });
  }
};
