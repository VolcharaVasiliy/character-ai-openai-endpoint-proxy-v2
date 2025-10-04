const { v4: uuidv4 } = require('uuid');

// Кэш для хранения сессий
const sessionCache = new Map();

// CORS заголовки
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// Character.AI API класс
class CharacterAIClient {
  constructor(token) {
    this.token = token;
    this.baseURL = 'https://beta.character.ai';
    this.headers = {
      'Authorization': `Token ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
  }
  
  async createOrContinueChat(characterId, historyId = null) {
    try {
      // Если есть история, продолжаем чат
      if (historyId) {
        return { characterId, historyId };
      }
      
      // Создаем новый чат
      const response = await fetch(`${this.baseURL}/chat/history/create/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          character_external_id: characterId
        })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to create chat: ${response.statusText}`);
      }
      
      const data = await response.json();
      return {
        characterId,
        historyId: data.external_id
      };
    } catch (error) {
      console.error('Chat creation error:', error);
      throw error;
    }
  }
  
  async sendMessage(characterId, historyId, message) {
    try {
      const response = await fetch(`${this.baseURL}/chat/streaming/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          history_external_id: historyId,
          character_external_id: characterId,
          text: message,
          tgt: characterId,
          ranking_method: 'random',
          staging: false,
          model_server_address: null,
          override_prefix: null,
          override_rank: null,
          rank_candidates: null,
          filter_candidates: null,
          enable_tti: true,
          initial_timeout: null,
          insert_beginning: null,
          translate_candidates: null,
          stream_every_n_steps: 16,
          chunks_to_pad: 8,
          is_proactive: false
        })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`);
      }
      
      // Читаем streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.trim() === '') continue;
          
          try {
            const data = JSON.parse(line);
            if (data.replies && data.replies.length > 0) {
              fullResponse = data.replies[0].text;
            }
          } catch (e) {
            // Игнорируем не-JSON строки
          }
        }
      }
      
      return fullResponse || 'Не удалось получить ответ';
    } catch (error) {
      console.error('Send message error:', error);
      throw error;
    }
  }
}

// Получение или создание клиента
function getOrCreateClient(token) {
  const cacheKey = `client_${token}`;
  
  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey);
  }
  
  const client = new CharacterAIClient(token);
  sessionCache.set(cacheKey, client);
  
  // Очистка кэша через 30 минут
  setTimeout(() => {
    sessionCache.delete(cacheKey);
  }, 30 * 60 * 1000);
  
  return client;
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
    // Проверка авторизации
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
    
    // Создание клиента
    const client = getOrCreateClient(token);
    
    // Получение или создание истории чата
    const sessionKey = `session_${token}_${characterId}`;
    let session = sessionCache.get(sessionKey);
    
    if (!session) {
      session = await client.createOrContinueChat(characterId);
      sessionCache.set(sessionKey, session);
    }
    
    // Отправка сообщения и получение ответа
    const response = await client.sendMessage(
      characterId,
      session.historyId,
      userMessage.content
    );
    
    // Формирование ответа в формате OpenAI
    const completionId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);
    
    if (stream) {
      // Streaming response (Server-Sent Events)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      // Разбиваем ответ на части для имитации streaming
      const words = response.split(' ');
      const chunkSize = 5; // Слов в чанке
      
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(' ') + ' ';
        const streamData = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: created,
          model: body.model,
          choices: [{
            index: 0,
            delta: {
              content: chunk
            },
            finish_reason: null
          }]
        };
        
        res.write(`data: ${JSON.stringify(streamData)}\n\n`);
      }
      
      // Финальный чанк
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
          prompt_tokens: Math.floor(userMessage.content.length / 4),
          completion_tokens: Math.floor(response.length / 4),
          total_tokens: Math.floor((userMessage.content.length + response.length) / 4)
        }
      };
      
      res.status(200).json(completion);
    }
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }
    });
  }
};
