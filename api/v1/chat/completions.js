const CharacterAI = require('node_characterai');
const cors = require('cors');

// Включаем CORS
const corsMiddleware = cors({
  origin: '*',
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

// Хранилище сессий (в production лучше использовать Redis)
const sessions = new Map();

// Функция для обработки CORS
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

module.exports = async (req, res) => {
  // Обработка CORS
  await runMiddleware(req, res, corsMiddleware);
  
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
    const body = req.body;

    // Парсим токен (формат: accessToken:characterId:chatId?)
    const [accessToken, characterId, chatId] = token.split(':');
    
    if (!accessToken || !characterId) {
      return res.status(400).json({ 
        error: 'Invalid token format. Use: accessToken:characterId:chatId' 
      });
    }

    // Получаем или создаем клиент
    const sessionKey = `${accessToken}_${characterId}`;
    let client = sessions.get(sessionKey);
    
    if (!client) {
      client = new CharacterAI();
      await client.authenticateWithToken(accessToken);
      sessions.set(sessionKey, client);
      
      // Очищаем старые сессии через 30 минут
      setTimeout(() => sessions.delete(sessionKey), 30 * 60 * 1000);
    }

    // Получаем или создаем чат
    let chat;
    if (chatId) {
      // Продолжаем существующий чат
      chat = await client.continueChat(characterId, chatId);
    } else {
      // Создаем новый чат
      chat = await client.createOrContinueChat(characterId);
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
      system_fingerprint: `cai_${characterId}_${chat.chatId}`
    };

    // Добавляем информацию о чате в заголовки для клиента
    res.setHeader('X-Chat-Id', chat.chatId || '');
    res.setHeader('X-Character-Id', characterId);
    
    return res.status(200).json(openAIResponse);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: error.message || 'Internal server error',
      details: error.toString()
    });
  }
};
