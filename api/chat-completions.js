const CharacterAI = require('node_characterai');

// Хранилище сессий
const sessions = new Map();

// Включаем CORS
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async (req, res) => {
  // Устанавливаем CORS заголовки
  Object.entries(headers).forEach(([key, value]) => {
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
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authorization.replace('Bearer ', '');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Парсим токен (формат: accessToken:characterId:chatId?)
    const [accessToken, characterId, chatId] = token.split(':');
    
    if (!accessToken || !characterId) {
      return res.status(400).json({ 
        error: 'Invalid token format. Use: accessToken:characterId:chatId' 
      });
    }

    // Получаем или создаем клиент
    const sessionKey = `${accessToken}_${characterId}`;
    let clientData = sessions.get(sessionKey);
    
    if (!clientData) {
      const client = new CharacterAI();
      await client.authenticateWithToken(accessToken);
      clientData = { client, chats: new Map() };
      sessions.set(sessionKey, clientData);
      
      // Очищаем старые сессии через 30 минут
      setTimeout(() => sessions.delete(sessionKey), 30 * 60 * 1000);
    }

    // Получаем или создаем чат
    let chat = clientData.chats.get(chatId || 'default');
    
    if (!chat) {
      if (chatId) {
        // Пытаемся продолжить существующий чат
        try {
          chat = await clientData.client.continueChat(characterId, chatId);
        } catch (e) {
          // Если не получилось, создаем новый
          chat = await clientData.client.createOrContinueChat(characterId);
        }
      } else {
        // Создаем новый чат
        chat = await clientData.client.createOrContinueChat(characterId);
      }
      clientData.chats.set(chatId || 'default', chat);
    }

    // Извлекаем последнее сообщение пользователя
    const messages = body.messages || [];
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    
    if (!lastUserMessage) {
      return res.status(400).json({ error: 'No user message found' });
    }

    // Отправляем сообщение в Character.AI
    const response = await chat.sendAndAwaitResponse(lastUserMessage.content, true);

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
          content: response.text || ''
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: lastUserMessage.content.length,
        completion_tokens: response.text ? response.text.length : 0,
        total_tokens: lastUserMessage.content.length + (response.text ? response.text.length : 0)
      },
      system_fingerprint: `cai_${characterId}_${chat.chatId || 'unknown'}`
    };

    // Добавляем информацию о чате в заголовки
    if (chat.chatId) {
      res.setHeader('X-Chat-Id', chat.chatId);
    }
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
