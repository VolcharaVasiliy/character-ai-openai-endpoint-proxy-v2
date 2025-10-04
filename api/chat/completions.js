const CharacterAI = require("node_characterai");
const cors = require("cors");

// Настройка CORS
const corsMiddleware = cors({
  methods: ['GET', 'POST', 'OPTIONS'],
  origin: '*',
  credentials: true,
});

// Helper для CORS
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

// Хранилище активных клиентов (в памяти для каждого инстанса)
const clientsCache = new Map();
const conversationHistory = new Map(); // Хранение истории диалогов

// Функция для парсинга character_id из модели
function parseModelInfo(model) {
  // Формат: "character_id" или "character_id:chat_id"
  const parts = model.split(':');
  return {
    characterId: parts[0],
    chatId: parts[1] || null
  };
}

// Функция для сохранения состояния диалога
function saveConversationState(userId, characterId, chatId, messages) {
  const key = `${userId}:${characterId}`;
  const state = {
    chatId,
    messages: messages.slice(-100), // Сохраняем последние 100 сообщений
    lastActivity: Date.now()
  };
  
  conversationHistory.set(key, state);
}

// Функция для загрузки состояния диалога
function loadConversationState(userId, characterId) {
  const key = `${userId}:${characterId}`;
  const state = conversationHistory.get(key);
  
  // Проверяем, не устарело ли состояние (24 часа)
  if (state && (Date.now() - state.lastActivity) < 86400000) {
    return state;
  }
  
  return null;
}

module.exports = async function handler(req, res) {
  // Применяем CORS
  await runMiddleware(req, res, corsMiddleware);

  // Обработка OPTIONS запроса
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      model,
      messages = [],
      stream = false,
      temperature = 0.7,
      max_tokens = 2048
    } = req.body;

    // Извлекаем токен из заголовка Authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    
    // Парсим информацию из модели
    const { characterId, chatId: providedChatId } = parseModelInfo(model);
    
    if (!characterId) {
      return res.status(400).json({ error: 'Character ID is required in model field' });
    }

    // Создаем уникальный ID пользователя на основе токена (первые 8 символов)
    const userId = token.substring(0, 8);
    const cacheKey = `${userId}:${token}`;

    // Получаем или создаем клиента
    let characterAI = clientsCache.get(cacheKey);
    
    if (!characterAI) {
      characterAI = new CharacterAI();
      
      // Настраиваем клиент перед авторизацией
      characterAI.requester.puppeteer = false; // Отключаем Puppeteer для Vercel
      characterAI.requester.usePlus = false; // Используем обычную версию
      
      try {
        await characterAI.authenticateWithToken(token);
        clientsCache.set(cacheKey, characterAI);
        
        // Очищаем старые клиенты каждые 30 минут
        setTimeout(() => {
          clientsCache.delete(cacheKey);
        }, 30 * 60 * 1000);
      } catch (error) {
        console.error('Authentication error:', error);
        return res.status(401).json({ error: 'Failed to authenticate with Character.AI' });
      }
    }

    // Получаем последнее сообщение пользователя
    const userMessage = messages.filter(m => m.role === 'user').pop();
    if (!userMessage) {
      return res.status(400).json({ error: 'No user message found' });
    }

    // Загружаем или создаем состояние диалога
    let conversationState = loadConversationState(userId, characterId);
    let chatId = providedChatId || (conversationState ? conversationState.chatId : null);
    let chat;
    
    try {
      if (!chatId) {
        // Создаем новый чат
        chat = await characterAI.createOrContinueChat(characterId);
        
        // Сохраняем ID чата
        if (chat && chat.externalId) {
          chatId = chat.externalId;
        }
      } else {
        // Продолжаем существующий чат
        chat = await characterAI.createOrContinueChat(characterId, chatId);
      }

      if (!chat) {
        throw new Error('Failed to create or continue chat');
      }

      // Отправляем сообщение и получаем ответ
      const response = await chat.sendAndAwaitResponse(userMessage.content, true);
      
      if (!response || !response.text) {
        throw new Error('Invalid response from Character.AI');
      }

      const responseText = response.text;

      // Обновляем историю
      const messageHistory = conversationState ? conversationState.messages : [];
      messageHistory.push(
        { role: 'user', content: userMessage.content },
        { role: 'assistant', content: responseText }
      );

      // Сохраняем состояние
      saveConversationState(userId, characterId, chatId, messageHistory);

      // Формируем ответ в формате OpenAI
      if (stream) {
        // Для стриминга настраиваем SSE
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        // Эмулируем стриминг, разбивая ответ на части
        const chunks = responseText.match(/.{1,20}/g) || [];
        
        for (const chunk of chunks) {
          const data = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          };
          
          res.write(`data: ${JSON.stringify(data)}\n\n`);
          
          // Небольшая задержка для эмуляции стриминга
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        // Завершающее сообщение
        const finalData = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        };
        
        res.write(`data: ${JSON.stringify(finalData)}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
        
      } else {
        // Обычный ответ
        const openAIResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: `${characterId}:${chatId || 'new'}`,
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
        };
        
        return res.status(200).json(openAIResponse);
      }
      
    } catch (chatError) {
      console.error('Chat error:', chatError);
      
      // Пытаемся создать новый чат при ошибке
      if (!providedChatId) {
        try {
          chat = await characterAI.createOrContinueChat(characterId);
          const response = await chat.sendAndAwaitResponse(userMessage.content, true);
          
          if (response && response.text) {
            const responseText = response.text;
            
            // Сохраняем новый чат
            saveConversationState(userId, characterId, chat.externalId, [
              { role: 'user', content: userMessage.content },
              { role: 'assistant', content: responseText }
            ]);
            
            return res.status(200).json({
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: `${characterId}:${chat.externalId || 'new'}`,
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
        } catch (retryError) {
          console.error('Retry error:', retryError);
        }
      }
      
      return res.status(500).json({ 
        error: 'Failed to send message',
        details: chatError.message 
      });
    }
    
  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
};
