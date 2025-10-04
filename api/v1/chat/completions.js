const { CAINode } = require('cainode');
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

// Получение или создание клиента CAINode
async function getOrCreateClient(token) {
  const cacheKey = `client_${token}`;
  
  // Проверяем кэш
  if (clientCache.has(cacheKey)) {
    const client = clientCache.get(cacheKey);
    // Проверяем, что клиент еще подключен
    if (client && client.is_authenticated) {
      return client;
    }
  }
  
  // Создаем новый клиент
  const client = new CAINode();
  
  try {
    // Логинимся с токеном
    await client.login(token);
    
    // Сохраняем в кэш
    clientCache.set(cacheKey, client);
    
    // Очищаем кэш через 20 минут
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
  
  // Проверяем кэш
  if (chatCache.has(cacheKey)) {
    return chatCache.get(cacheKey);
  }
  
  try {
    // Подключаемся к персонажу
    await client.character.connect(characterId);
    
    // Сохраняем информацию о чате
    const chatInfo = {
      characterId: characterId,
      chatId: client.character.chat_id,
      client: client
    };
    
    chatCache.set(cacheKey, chatInfo);
    
    // Очищаем кэш через 15 минут
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
  // Формат: "character-ai:CHARACTER_ID" или просто "CHARACTER_ID"
  if (model.startsWith('character-ai:')) {
    return model.substring('character-ai:'.length);
  }
  return model;
}

// Преобразование истории сообщений OpenAI в формат для отправки
function formatMessagesForSending(messages) {
  // Берем только последнее сообщение пользователя
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) {
    return null;
  }
  return userMessages[userMessages.length - 1].content;
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
    // Проверка авторизации
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ 
        error: {
          message: 'Missing or invalid authorization header. Use "Bearer YOUR_CHARACTER_AI_TOKEN"',
          type: 'invalid_request_error'
        }
      });
      return;
    }
    
    const token = authHeader.substring('Bearer '.length).trim();
    const body = req.body || {};
    
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
    
    // Получение текста сообщения для отправки
    const messageText = formatMessagesForSending(messages);
    
    if (!messageText) {
      res.status(400).json({ 
        error: {
          message: 'No user message found in messages array',
          type: 'invalid_request_error'
        }
      });
      return;
    }
    
    console.log(`Processing request for character: ${characterId}`);
    
    // Создание или получение клиента
    client = await getOrCreateClient(token);
    
    // Создание или получение чата
    const chatInfo = await getOrCreateChat(client, characterId, token);
    
    // Отправка сообщения
    let responseText = '';
    
    if (stream) {
      // Streaming mode
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      const completionId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);
      
      try {
        // Отправляем сообщение с streaming
        await client.character.send_message(messageText, {
          streaming: true,
          callback: (token) => {
            // Отправляем каждый токен как chunk
            if (token) {
              responseText += token;
              
              const chunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: created,
                model: body.model,
                choices: [{
                  index: 0,
                  delta: {
                    content: token
                  },
                  finish_reason: null
                }]
              };
              
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
        });
        
        // Отправляем финальный chunk
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
        
      } catch (error) {
        console.error('Streaming error:', error);
        // Отправляем ошибку в stream
        const errorChunk = {
          error: {
            message: error.message,
            type: 'stream_error'
          }
        };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        res.end();
      }
      
    } else {
      // Regular mode (без streaming)
      try {
        // Отправляем сообщение и ждем полный ответ
        const response = await client.character.send_message(messageText, {
          manual_turn: false,
          char_id: characterId,
          chat_id: chatInfo.chatId
        });
        
        // Извлекаем текст ответа
        if (response && response.turn) {
          // Получаем последний ответ персонажа
          const candidates = response.turn.candidates || [];
          if (candidates.length > 0) {
            responseText = candidates[0].raw_content || 'No response generated';
          } else {
            responseText = 'No response candidates found';
          }
        } else if (typeof response === 'string') {
          responseText = response;
        } else {
          responseText = 'Unable to get response from Character.AI';
        }
        
      } catch (sendError) {
        console.error('Message send error:', sendError);
        
        // Пытаемся переподключиться и отправить еще раз
        try {
          await client.character.disconnect();
          await client.character.connect(characterId);
          
          const response = await client.character.send_message(messageText);
          
          if (response && response.turn && response.turn.candidates) {
            responseText = response.turn.candidates[0].raw_content || 'No response';
          } else {
            responseText = 'Failed to get response after reconnection';
          }
        } catch (retryError) {
          console.error('Retry failed:', retryError);
          throw new Error(`Failed to send message: ${retryError.message}`);
        }
      }
      
      // Формируем ответ в формате OpenAI
      const completionId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);
      
      const completion = {
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
          prompt_tokens: Math.ceil(messageText.length / 4),
          completion_tokens: Math.ceil(responseText.length / 4),
          total_tokens: Math.ceil((messageText.length + responseText.length) / 4)
        }
      };
      
      res.status(200).json(completion);
    }
    
  } catch (error) {
    console.error('API Error:', error);
    
    // Очищаем клиент из кэша при ошибке
    if (client) {
      try {
        await client.logout();
      } catch (e) {
        // Игнорируем ошибки при logout
      }
    }
    
    res.status(500).json({ 
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }
    });
  }
};
