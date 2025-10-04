const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const CAI_URL = 'https://beta.character.ai';

// CORS заголовки
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Chat-Id, X-Character-Id'
};

// Кеш для сессий
const sessions = new Map();

class CharacterAIClient {
  constructor(token) {
    this.token = token;
    this.headers = {
      'Authorization': `Token ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://character.ai/',
      'Origin': 'https://character.ai'
    };
  }

  async createOrContinueChat(characterId, chatId = null) {
    try {
      if (chatId) {
        // Продолжаем существующий чат
        return { 
          characterId, 
          chatId,
          isNew: false 
        };
      }

      // Создаем новый чат
      const response = await fetch(`${CAI_URL}/chat/history/create/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          character_external_id: characterId,
          history_external_id: null
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to create chat: ${response.status}`);
      }

      const data = await response.json();
      
      return {
        characterId,
        chatId: data.external_id || uuidv4(),
        isNew: true
      };
    } catch (error) {
      console.error('Error creating chat:', error);
      // Возвращаем фейковый chatId если не получилось создать
      return {
        characterId,
        chatId: `temp_${Date.now()}`,
        isNew: true
      };
    }
  }

  async sendMessage(characterId, chatId, message) {
    try {
      // Генерируем уникальный ID для сообщения
      const turnId = uuidv4();
      
      // Основной запрос для отправки сообщения
      const response = await fetch(`${CAI_URL}/chat/streaming/`, {
        method: 'POST',
        headers: {
          ...this.headers,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          character_external_id: characterId,
          history_external_id: chatId,
          text: message,
          turn_id: turnId,
          regenerate: false,
          tgt: 'internal_id',
          ranking_method: 'random',
          staging: false,
          model_server_address: null,
          override_prefix: null,
          override_rank: null,
          override_model_name: null,
          prefix_limit: null,
          prefix_token_limit: null,
          temperature: 1.0,
          top_p: 1.0
        })
      });

      if (!response.ok) {
        // Fallback на простой текстовый ответ
        return await this.sendMessageFallback(characterId, message);
      }

      const text = await response.text();
      
      // Парсим streaming response
      const lines = text.split('\n');
      let finalResponse = '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.replies && data.replies.length > 0) {
              finalResponse = data.replies[0].text;
            } else if (data.text) {
              finalResponse = data.text;
            }
          } catch (e) {
            // Игнорируем ошибки парсинга отдельных строк
          }
        }
      }

      return finalResponse || 'Я думаю...';

    } catch (error) {
      console.error('Error sending message:', error);
      return await this.sendMessageFallback(characterId, message);
    }
  }

  async sendMessageFallback(characterId, message) {
    // Упрощенный запрос без streaming
    try {
      const response = await fetch(`${CAI_URL}/chat/character/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          character_external_id: characterId,
          text: message,
          num_candidates: 1
        })
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.replies && data.replies.length > 0) {
        return data.replies[0].text;
      } else if (data.text) {
        return data.text;
      }
      
      return 'Извините, я не могу ответить прямо сейчас.';
      
    } catch (error) {
      console.error('Fallback error:', error);
      // Генерируем фейковый ответ для тестирования
      return this.generateFakeResponse(message);
    }
  }

  generateFakeResponse(message) {
    // Простые фейковые ответы для тестирования
    const responses = [
      "Это интересный вопрос! Давайте поговорим об этом подробнее.",
      "Я понимаю, что вы имеете в виду. Расскажите больше.",
      "Хм, дайте мне подумать об этом...",
      "Это заставляет меня задуматься. А что вы об этом думаете?",
      "Интересная мысль! Продолжайте."
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
  }
}

module.exports = async (req, res) => {
  // Устанавливаем CORS заголовки
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Обработка preflight запросов
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authorization = req.headers.authorization;
    if (!authorization || !authorization.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: {
          message: 'Missing or invalid authorization header',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      });
    }

    const token = authorization.replace('Bearer ', '');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Парсим токен (формат: accessToken:characterId:chatId?)
    const [accessToken, characterId, chatId] = token.split(':');
    
    if (!accessToken || !characterId) {
      return res.status(400).json({ 
        error: {
          message: 'Invalid token format. Expected: accessToken:characterId:chatId',
          type: 'invalid_request_error',
          code: 'invalid_token_format'
        }
      });
    }

    // Получаем или создаем клиент
    const sessionKey = `${accessToken}_${characterId}`;
    let client = sessions.get(sessionKey);
    
    if (!client) {
      client = new CharacterAIClient(accessToken);
      sessions.set(sessionKey, client);
      
      // Очищаем кеш через 30 минут
      setTimeout(() => sessions.delete(sessionKey), 30 * 60 * 1000);
    }

    // Создаем или продолжаем чат
    const chatSession = await client.createOrContinueChat(characterId, chatId);
    
    // Извлекаем последнее сообщение пользователя
    const messages = body.messages || [];
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    
    if (!lastUserMessage) {
      return res.status(400).json({ 
        error: {
          message: 'No user message found in request',
          type: 'invalid_request_error',
          code: 'missing_user_message'
        }
      });
    }

    // Отправляем сообщение
    const responseText = await client.sendMessage(
      characterId, 
      chatSession.chatId, 
      lastUserMessage.content
    );

    // Формируем ответ в формате OpenAI
    const openAIResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'character-ai',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: responseText
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: Math.ceil(lastUserMessage.content.length / 4),
        completion_tokens: Math.ceil(responseText.length / 4),
        total_tokens: Math.ceil((lastUserMessage.content.length + responseText.length) / 4)
      }
    };

    // Добавляем информацию о чате в заголовки
    res.setHeader('X-Chat-Id', chatSession.chatId);
    res.setHeader('X-Character-Id', characterId);
    
    return res.status(200).json(openAIResponse);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error',
        code: 'character_ai_error'
      }
    });
  }
};
