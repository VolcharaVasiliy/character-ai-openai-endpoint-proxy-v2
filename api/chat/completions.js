// Простая реализация без внешних зависимостей для Character.AI
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

// Кэш для сессий
const sessions = new Map();

// Базовые заголовки для Character.AI
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  'Origin': 'https://character.ai',
  'Referer': 'https://character.ai/',
};

// Функция для работы с Character.AI API
async function callCharacterAI(characterId, message, token) {
  try {
    // Для демонстрации - эмуляция ответа
    // В реальности здесь должен быть вызов Character.AI API
    
    // Временная заглушка с эмуляцией ответа
    const responses = [
      "Привет! Рад с тобой поговорить. Как у тебя дела?",
      "Это интересный вопрос! Давай обсудим это подробнее.",
      "Я понимаю, о чем ты говоришь. Могу рассказать больше.",
      "Отличная мысль! Что ты думаешь об этом?",
      "Спасибо за сообщение! Я здесь, чтобы помочь тебе."
    ];
    
    // Выбираем случайный ответ для демонстрации
    const randomResponse = responses[Math.floor(Math.random() * responses.length)];
    
    // Добавляем небольшую задержку для реалистичности
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return randomResponse;
    
  } catch (error) {
    console.error('Character.AI API Error:', error);
    throw error;
  }
}

module.exports = async (req, res) => {
  // Устанавливаем CORS заголовки
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  
  // Обработка preflight запросов
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  // Обработка GET запросов (для тестирования)
  if (req.method === 'GET') {
    res.status(200).json({
      status: 'ok',
      message: 'Character.AI OpenAI Proxy is running',
      usage: {
        method: 'POST',
        endpoint: '/api/chat/completions',
        body: {
          model: 'character-ID or just ID',
          messages: [
            { role: 'user', content: 'Your message' }
          ]
        }
      }
    });
    return;
  }
  
  // Обработка POST запросов
  if (req.method !== 'POST') {
    res.status(405).json({
      error: {
        message: 'Method not allowed. Use POST',
        type: 'method_not_allowed'
      }
    });
    return;
  }
  
  try {
    console.log('Request received:', {
      method: req.method,
      headers: req.headers,
      body: req.body
    });
    
    // Извлекаем данные из запроса
    const { 
      messages = [], 
      model = '',
      stream = false,
      temperature = 0.7,
      max_tokens = 2048
    } = req.body || {};
    
    // Получаем токен
    const authHeader = req.headers.authorization || req.headers['x-api-key'] || '';
    const token = authHeader.replace('Bearer ', '').trim() || 'guest';
    
    // Извлекаем Character ID из модели
    let characterId = model;
    if (!characterId) {
      res.status(400).json({
        error: {
          message: 'Model (Character ID) is required',
          type: 'invalid_request_error',
          code: 'model_required'
        }
      });
      return;
    }
    
    // Очищаем ID от префиксов
    characterId = characterId
      .replace('character-', '')
      .replace('character_', '')
      .trim();
    
    // Получаем последнее сообщение пользователя
    const userMessage = messages
      .filter(m => m.role === 'user')
      .pop();
    
    if (!userMessage || !userMessage.content) {
      res.status(400).json({
        error: {
          message: 'User message is required',
          type: 'invalid_request_error'
        }
      });
      return;
    }
    
    console.log('Processing:', {
      characterId,
      message: userMessage.content,
      token: token.substring(0, 10) + '...'
    });
    
    // Вызываем Character.AI
    const response = await callCharacterAI(
      characterId, 
      userMessage.content,
      token
    );
    
    // Формируем OpenAI-совместимый ответ
    const completion = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      system_fingerprint: `character_${characterId}`,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: response
        },
        logprobs: null,
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: Math.ceil(userMessage.content.length / 4),
        completion_tokens: Math.ceil(response.length / 4),
        total_tokens: Math.ceil((userMessage.content.length + response.length) / 4)
      }
    };
    
    // Обработка streaming
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Разбиваем ответ на части для streaming
      const words = response.split(' ');
      for (let i = 0; i < words.length; i++) {
        const chunk = {
          id: `chatcmpl-${uuidv4()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          system_fingerprint: `character_${characterId}`,
          choices: [{
            index: 0,
            delta: {
              content: words[i] + (i < words.length - 1 ? ' ' : '')
            },
            logprobs: null,
            finish_reason: i === words.length - 1 ? 'stop' : null
          }]
        };
        
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        
        // Небольшая задержка между чанками
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Обычный ответ
      res.status(200).json(completion);
    }
    
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error',
        code: 'internal_error'
      }
    });
  }
};
