import { CAINode } from 'cainode';
import Cors from 'cors';

// Настройка CORS
const cors = Cors({
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
function saveConversationState(userId, characterId, chatId, history) {
  const key = `${userId}:${characterId}`;
  const state = {
    chatId,
    history: history.slice(-50), // Сохраняем последние 50 сообщений
    lastActivity: Date.now()
  };
  
  // Для Vercel используем глобальную переменную
  if (!global.conversationStates) {
    global.conversationStates = new Map();
  }
  global.conversationStates.set(key, state);
}

// Функция для загрузки состояния диалога
function loadConversationState(userId, characterId) {
  if (!global.conversationStates) {
    return null;
  }
  
  const key = `${userId}:${characterId}`;
  const state = global.conversationStates.get(key);
  
  // Проверяем, не устарело ли состояние (24 часа)
  if (state && (Date.now() - state.lastActivity) < 86400000) {
    return state;
  }
  
  return null;
}

export default async function handler(req, res) {
  // Применяем CORS
  await runMiddleware(req, res, cors);

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
    let client = clientsCache.get(cacheKey);
    
    if (!client || !client.isReady) {
      client = new CAINode();
      
      try {
        await client.login(token);
        clientsCache.set(cacheKey, client);
        
        // Очищаем старые клиенты каждые 30 минут
        setTimeout(() => {
          clientsCache.delete(cacheKey);
        }, 30 * 60 * 1000);
      } catch (error) {
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
    let isNewChat = !chatId;
    
    // Подключаемся к персонажу или продолжаем чат
    if (!chatId) {
      // Создаем новый чат
      await client.character.connect(characterId);
      const chatInfo = await client.character.create_new_conversation();
      chatId = chatInfo.chat_id;
      
      // Получаем приветственное сообщение
      const greeting = chatInfo.messages?.[0];
      if (greeting) {
        conversationState = {
          chatId,
          history: [{
            role: 'assistant',
            content: greeting.text || greeting.content || ''
          }],
          lastActivity: Date.now()
        };
      }
    } else {
      // Продолжаем существующий чат
      await client.character.connect(characterId);
      
      // Загружаем историю, если есть
      if (conversationState && conversationState.history) {
        // История уже загружена из состояния
      } else {
        // Пытаемся загрузить историю из Character.AI
        try {
          const history = await client.chat.history_conversation_list(characterId);
          if (history && Array.isArray(history)) {
            conversationState = {
              chatId,
              history: history.map(msg => ({
                role: msg.is_user ? 'user' : 'assistant',
                content: msg.text
              })),
              lastActivity: Date.now()
            };
          }
        } catch (historyError) {
          console.error('Failed to load history:', historyError);
          conversationState = { chatId, history: [], lastActivity: Date.now() };
        }
      }
    }

    // Отправляем сообщение
    let responseText = '';
    
    try {
      const response = await client.character.send_message(
        userMessage.content,
        { 
          char_id: characterId,
          chat_id: chatId,
          streaming: stream
        }
      );

      if (stream) {
        // Для стриминга настраиваем SSE
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        // Отправляем чанки по мере получения
        for await (const chunk of response) {
          const text = chunk.text || chunk.content || '';
          responseText += text;
          
          const data = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null
            }]
          };
          
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
        
        // Завершающее сообщение
        res.write(`data: [DONE]\n\n`);
        res.end();
      } else {
        // Обычный ответ
        responseText = response.text || response.content || '';
        
        // Обновляем историю
        if (conversationState) {
          conversationState.history.push(
            { role: 'user', content: userMessage.content },
            { role: 'assistant', content: responseText }
          );
        }
        
        // Сохраняем состояние
        saveConversationState(userId, characterId, chatId, conversationState.history);
        
        // Формируем ответ в формате OpenAI
        const openAIResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: `${characterId}:${chatId}`,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: responseText
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: userMessage.content.length,
            completion_tokens: responseText.length,
            total_tokens: userMessage.content.length + responseText.length
          }
        };
        
        return res.status(200).json(openAIResponse);
      }
    } catch (sendError) {
      console.error('Send message error:', sendError);
      return res.status(500).json({ 
        error: 'Failed to send message',
        details: sendError.message 
      });
    }
    
  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}
