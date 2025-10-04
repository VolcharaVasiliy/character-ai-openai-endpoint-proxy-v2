const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

// Кэш для хранения сессий
const sessionCache = new Map();
const chatHistories = new Map();

// CORS заголовки
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true'
};

// Парсинг cookies из токена Character.AI
function parseCookies(cookieString) {
  const cookies = {};
  if (cookieString) {
    cookieString.split(';').forEach(cookie => {
      const [key, value] = cookie.trim().split('=');
      if (key && value) {
        cookies[key] = value;
      }
    });
  }
  return cookies;
}

// Character.AI API класс  
class CharacterAIAPI {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.baseURL = 'https://beta.character.ai';
    this.headers = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Content-Type': 'application/json',
      'Authorization': `Token ${accessToken}`,
      'Origin': 'https://character.ai',
      'Referer': 'https://character.ai/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Chromium";v="118", "Google Chrome";v="118", "Not=A?Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    };
  }

  async fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, options);
        
        if (response.status === 429) {
          // Rate limit - ждем перед повтором
          await new Promise(resolve => setTimeout(resolve, (i + 1) * 2000));
          continue;
        }
        
        return response;
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async getCharacterInfo(characterId) {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseURL}/chat/character/info/`,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            external_id: characterId
          })
        }
      );

      if (!response.ok) {
        console.error('Failed to get character info:', response.status);
        return null;
      }

      const data = await response.json();
      return data.character;
    } catch (error) {
      console.error('Get character info error:', error);
      return null;
    }
  }

  async createChat(characterId) {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseURL}/chat/history/create/`,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            character_external_id: characterId,
            history_external_id: null
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Failed to create chat:', response.status, errorText);
        throw new Error(`Failed to create chat: ${response.status}`);
      }

      const data = await response.json();
      return data.external_id;
    } catch (error) {
      console.error('Create chat error:', error);
      throw error;
    }
  }

  async continueChat(characterId, historyId) {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseURL}/chat/history/continue/`,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            character_external_id: characterId,
            history_external_id: historyId
          })
        }
      );

      if (!response.ok) {
        console.error('Failed to continue chat:', response.status);
        // Если не удалось продолжить, создаем новый чат
        return await this.createChat(characterId);
      }

      const data = await response.json();
      return data.external_id || historyId;
    } catch (error) {
      console.error('Continue chat error:', error);
      // Fallback к созданию нового чата
      return await this.createChat(characterId);
    }
  }

  async sendMessage(characterId, historyId, text) {
    try {
      // Отправляем сообщение через streaming endpoint
      const response = await this.fetchWithRetry(
        `${this.baseURL}/chat/streaming/`,
        {
          method: 'POST',
          headers: {
            ...this.headers,
            'Accept': 'text/event-stream'
          },
          body: JSON.stringify({
            history_external_id: historyId,
            character_external_id: characterId,
            text: text,
            tgt: characterId,
            ranking_method: 'random',
            staging: false,
            model_server_address: null,
            override_prefix: null,
            override_rank: null,
            rank_candidates: null,
            filter_candidates: null,
            prefix_limit: null,
            prefix_token_limit: null,
            livetune_coeff: null,
            stream_params: null,
            enable_tti: true,
            initial_timeout: null,
            insert_beginning: null,
            translate_candidates: null,
            stream_every_n_steps: 16,
            chunks_to_pad: 8,
            is_proactive: false
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Failed to send message:', response.status, errorText);
        throw new Error(`Failed to send message: ${response.status}`);
      }

      // Читаем streaming response
      const responseText = await response.text();
      const lines = responseText.split('\n');
      
      let finalReply = '';
      let lastValidReply = '';
      
      for (const line of lines) {
        if (line.trim() === '') continue;
        
        try {
          const data = JSON.parse(line);
          
          if (data.replies && data.replies.length > 0) {
            lastValidReply = data.replies[0].text;
          }
          
          if (data.is_final_chunk) {
            finalReply = data.replies[0].text;
            break;
          }
        } catch (e) {
          // Игнорируем не-JSON строки
        }
      }
      
      return finalReply || lastValidReply || 'Извините, не удалось получить ответ.';
    } catch (error) {
      console.error('Send message error:', error);
      throw error;
    }
  }

  // Альтернативный метод для отправки сообщения (без streaming)
  async sendMessageSimple(characterId, text) {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseURL}/chat/send_message/`,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            character_external_id: characterId,
            text: text,
            tgt: characterId
          })
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.status}`);
      }

      const data = await response.json();
      return data.replies[0].text;
    } catch (error) {
      console.error('Send message simple error:', error);
      throw error;
    }
  }
}

// Парсинг модели для получения ID персонажа
function parseModelId(model) {
  if (model.startsWith('character-ai:')) {
    return model.substring('character-ai:'.length);
  }
  return model;
}

// Получение или создание клиента
function getOrCreateClient(token) {
  const cacheKey = `client_${token}`;
  
  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey);
  }
  
  const client = new CharacterAIAPI(token);
  sessionCache.set(cacheKey, client);
  
  // Очистка кэша через 30 минут
  setTimeout(() => {
    sessionCache.delete(cacheKey);
  }, 30 * 60 * 1000);
  
  return client;
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
    
    const token = authHeader.substring('Bearer '.length).trim();
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
    const historyKey = `history_${token}_${characterId}`;
    let historyId = chatHistories.get(historyKey);
    
    try {
      if (!historyId) {
        // Пробуем создать новый чат
        historyId = await client.createChat(characterId);
        chatHistories.set(historyKey, historyId);
      } else {
        // Пробуем продолжить существующий чат
        historyId = await client.continueChat(characterId, historyId);
        chatHistories.set(historyKey, historyId);
      }
    } catch (error) {
      console.error('Chat creation/continuation failed:', error);
      // Пробуем создать новый чат как fallback
      historyId = await client.createChat(characterId);
      chatHistories.set(historyKey, historyId);
    }
    
    // Отправка сообщения и получение ответа
    let response;
    try {
      if (historyId) {
        response = await client.sendMessage(characterId, historyId, userMessage.content);
      } else {
        // Fallback к простому методу
        response = await client.sendMessageSimple(characterId, userMessage.content);
      }
    } catch (error) {
      console.error('Message sending failed:', error);
      // Последняя попытка с новым чатом
      historyId = await client.createChat(characterId);
      chatHistories.set(historyKey, historyId);
      response = await client.sendMessage(characterId, historyId, userMessage.content);
    }
    
    // Формирование ответа в формате OpenAI
    const completionId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);
    
    if (stream) {
      // Server-Sent Events для streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      // Эмулируем streaming, разбивая ответ на слова
      const words = response.split(' ');
      
      for (let i = 0; i < words.length; i++) {
        const word = words[i] + (i < words.length - 1 ? ' ' : '');
        const streamData = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: created,
          model: body.model,
          choices: [{
            index: 0,
            delta: {
              content: word
            },
            finish_reason: null
          }]
        };
        
        res.write(`data: ${JSON.stringify(streamData)}\n\n`);
        
        // Небольшая задержка для эмуляции реального streaming
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Отправляем финальный чанк
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
      // Обычный ответ
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
          prompt_tokens: Math.ceil(userMessage.content.length / 4),
          completion_tokens: Math.ceil(response.length / 4),
          total_tokens: Math.ceil((userMessage.content.length + response.length) / 4)
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
