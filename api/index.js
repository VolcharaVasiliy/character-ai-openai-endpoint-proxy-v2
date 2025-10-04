const express = require('express');
const cors = require('cors');
const CharacterAI = require('node_characterai');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Хранилище сессий в памяти (для Vercel)
const sessions = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 час

// Очистка старых сессий
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (now - value.lastUsed > CACHE_TTL) {
      sessions.delete(key);
    }
  }
}, 10 * 60 * 1000); // каждые 10 минут

// Функция для получения или создания клиента Character.AI
async function getCharacterClient(token, characterId) {
  const sessionKey = `${token}_${characterId}`;
  
  if (sessions.has(sessionKey)) {
    const session = sessions.get(sessionKey);
    session.lastUsed = Date.now();
    return session;
  }

  const characterAI = new CharacterAI();
  
  try {
    // Аутентификация
    if (token && token !== 'guest') {
      await characterAI.authenticateWithToken(token);
    } else {
      await characterAI.authenticateAsGuest();
    }

    // Создание или продолжение чата
    const chat = await characterAI.createOrContinueChat(characterId);
    
    const session = {
      client: characterAI,
      chat: chat,
      characterId: characterId,
      history: [],
      lastUsed: Date.now()
    };
    
    sessions.set(sessionKey, session);
    return session;
  } catch (error) {
    console.error('Error creating Character.AI client:', error);
    throw error;
  }
}

// OpenAI-совместимый endpoint /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : 'guest';
    const { messages, model, stream = false, temperature, max_tokens } = req.body;

    // Извлекаем Character ID из модели или заголовка
    let characterId = model || req.headers['x-character-id'];
    
    // Если модель начинается с 'character-', извлекаем ID
    if (characterId && characterId.startsWith('character-')) {
      characterId = characterId.replace('character-', '');
    }

    if (!characterId) {
      return res.status(400).json({
        error: {
          message: 'Character ID is required. Use model field like "character-YOUR_CHARACTER_ID"',
          type: 'invalid_request_error',
          code: 'character_id_required'
        }
      });
    }

    // Получаем последнее сообщение пользователя
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();

    if (!lastUserMessage) {
      return res.status(400).json({
        error: {
          message: 'User message is required',
          type: 'invalid_request_error'
        }
      });
    }

    // Получаем или создаем сессию
    const session = await getCharacterClient(token, characterId);
    
    // Сохраняем историю из сообщений (если есть системное сообщение или контекст)
    const systemMessage = messages.find(m => m.role === 'system');
    if (systemMessage && systemMessage.content) {
      // Можно использовать системное сообщение для передачи контекста
      // В Character.AI нет прямой поддержки системных промптов
    }

    // Отправляем сообщение и получаем ответ
    const response = await session.chat.sendAndAwaitResponse(
      lastUserMessage.content, 
      true
    );

    // Сохраняем в историю
    session.history.push({
      role: 'user',
      content: lastUserMessage.content,
      timestamp: Date.now()
    });
    
    session.history.push({
      role: 'assistant',
      content: response.text || response,
      timestamp: Date.now()
    });

    // Формируем OpenAI-совместимый ответ
    const openAIResponse = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || `character-${characterId}`,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: response.text || response
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: lastUserMessage.content.length,
        completion_tokens: (response.text || response).length,
        total_tokens: lastUserMessage.content.length + (response.text || response).length
      }
    };

    // Поддержка streaming (базовая имитация)
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const text = response.text || response;
      const chunks = text.split(' ');
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = {
          id: `chatcmpl-${uuidv4()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model || `character-${characterId}`,
          choices: [{
            index: 0,
            delta: {
              content: chunks[i] + (i < chunks.length - 1 ? ' ' : '')
            },
            finish_reason: i === chunks.length - 1 ? 'stop' : null
          }]
        };
        
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json(openAIResponse);
    }

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error',
        code: 'internal_error'
      }
    });
  }
});

// Endpoint для получения списка моделей
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'character-default',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'character-ai',
        permission: [{
          allow_create_engine: false,
          allow_sampling: true,
          allow_logprobs: false,
          allow_search_indices: false,
          allow_view: true,
          allow_fine_tuning: false,
          organization: '*',
          group: null,
          is_blocking: false
        }],
        root: 'character-default',
        parent: null
      }
    ]
  });
});

// Endpoint для управления сессиями
app.post('/api/sessions/clear', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.replace('Bearer ', '') : null;
  
  if (token) {
    // Очищаем сессии для конкретного токена
    for (const [key, value] of sessions.entries()) {
      if (key.startsWith(token)) {
        sessions.delete(key);
      }
    }
  }
  
  res.json({ success: true, message: 'Sessions cleared' });
});

// Endpoint для получения истории
app.get('/api/history/:characterId', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.replace('Bearer ', '') : 'guest';
  const { characterId } = req.params;
  
  const sessionKey = `${token}_${characterId}`;
  const session = sessions.get(sessionKey);
  
  if (session) {
    res.json({
      history: session.history,
      characterId: session.characterId
    });
  } else {
    res.json({
      history: [],
      characterId: characterId
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    sessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

// OPTIONS для CORS preflight
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Character-Id');
  res.sendStatus(200);
});

module.exports = app;
