const { v4: uuidv4 } = require('uuid');

// Глобальный кэш для клиентов и чатов
const clientCache = new Map();
const chatCache = new Map();

// CORS заголовки
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true'
};

// Динамический импорт CAINode
let CAINode;
async function loadCAINode() {
  if (!CAINode) {
    const module = await import('cainode');
    CAINode = module.CAINode || module.default;
  }
  return CAINode;
}

// Получение или создание клиента
async function getOrCreateClient(token) {
  const cacheKey = `client_${token}`;
  
  if (clientCache.has(cacheKey)) {
    const client = clientCache.get(cacheKey);
    if (client && client.is_authenticated) {
      return client;
    }
  }
  
  // Загружаем CAINode динамически
  const CAINodeClass = await loadCAINode();
  const client = new CAINodeClass();
  
  try {
    await client.login(token);
    
    clientCache.set(cacheKey, client);
    
    setTimeout(() => {
      clientCache.delete(cacheKey);
      if (client.is_authenticated) {
        client.logout();
      }
    }, 20 * 60 * 1000);
    
    return client;
  } catch (error) {
    console.error('Client authentication error:', error);
    throw new Error(`Authentication failed: ${error.message}`);
  }
}

// Получение или создание чата
async function getOrCreateChat(client, characterId, token) {
  const cacheKey = `chat_${token}_${characterId}`;
  
  if (chatCache.has(cacheKey)) {
    return chatCache.get(cacheKey);
  }
  
  try {
    await client.character.connect(characterId);
    
    const chatInfo = {
      characterId: characterId,
      chatId: client.character.chat_id,
      client: client
    };
    
    chatCache.set(cacheKey, chatInfo);
    
    setTimeout(() => {
      chatCache.delete(cacheKey);
    }, 15 * 60 * 1000);
    
    return chatInfo;
  } catch (error) {
    console.error('Chat creation error:', error);
    throw new Error(`Failed to create chat: ${error.message}`);
  }
}

// Парсинг модели для получения ID персонажа
function parseModelId(model) {
  if (model.startsWith('character-ai:')) {
    return model.substring('character-ai:'.length);
  }
  return model;
}

// Основной обработчик
module.exports = async (req, res) => {
  // Установка CORS заголовков
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  
  // Обработка OPTIONS запроса для CORS
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'POST') {
    res.status(405).json({ 
      error: {
        message: 'Method not allowed',
        type: 'invalid_request_error'
      }
    });
    return;
  }
  
  let client = null;
  
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
    
    const token = authHeader.substring('Bearer '.length).trim();
    const body = req.body || {};
    
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
    
    const userMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    
    if (!userMessage || !userMessage.content) {
      res.status(400).json({ 
        error: {
          message: 'No user message found',
          type: 'invalid_request_error'
        }
      });
      return;
    }
    
    console.log(`Processing request for character: ${characterId}`);
    
    // Создание клиента и отправка сообщения
    client = await getOrCreateClient(token);
    const chatInfo = await getOrCreateChat(client, characterId, token);
    
    let responseText = '';
    
    try {
      const response = await client.character.send_message(userMessage.content, {
        manual_turn: false,
        char_id: characterId,
        chat_id: chatInfo.chatId
      });
      
      if (response && response.turn && response.turn.candidates) {
        responseText = response.turn.candidates[0].raw_content || 'No response';
      } else if (typeof response === 'string') {
        responseText = response;
      } else {
        responseText = 'Unable to get response';
      }
    } catch (sendError) {
      console.error('Send error:', sendError);
      responseText = 'Error: Unable to send message to Character.AI';
    }
    
    // Формируем ответ
    const completionId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const words = responseText.split(' ');
      for (const word of words) {
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: created,
          model: body.model,
          choices: [{
            index: 0,
            delta: { content: word + ' ' },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created: created,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(200).json({
        id: completionId,
        object: 'chat.completion',
        created: created,
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: responseText
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: Math.ceil(userMessage.content.length / 4),
          completion_tokens: Math.ceil(responseText.length / 4),
          total_tokens: Math.ceil((userMessage.content.length + responseText.length) / 4)
        }
      });
    }
  } catch (error) {
    console.error('API Error:', error);
    
    if (client) {
      try {
        await client.logout();
      } catch (e) {}
    }
    
    res.status(500).json({ 
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error'
      }
    });
  }
};
