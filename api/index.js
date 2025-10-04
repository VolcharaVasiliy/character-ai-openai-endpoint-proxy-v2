module.exports = async (req, res) => {
  // Включаем CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // OPTIONS запрос
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // GET запрос - возвращаем информацию
  if (req.method === 'GET') {
    res.status(200).json({
      status: 'running',
      message: 'Character.AI OpenAI Proxy',
      endpoint: '/api',
      method: 'POST',
      test_command: 'curl -X POST ' + (req.headers.host || 'localhost') + '/api -H "Content-Type: application/json" -d \'{"model":"test","messages":[{"role":"user","content":"Hi"}]}\''
    });
    return;
  }

  // Обработка POST запросов
  if (req.method === 'POST') {
    try {
      const { messages, model, stream = false } = req.body || {};
      
      // Проверка наличия модели
      if (!model) {
        return res.status(400).json({
          error: {
            message: 'Model (Character ID) is required',
            type: 'invalid_request_error',
            code: 'model_required'
          }
        });
      }

      // Проверка наличия сообщений
      if (!messages || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: 'Messages array is required',
            type: 'invalid_request_error',
            code: 'messages_required'
          }
        });
      }

      // Получаем последнее сообщение пользователя
      const userMessage = messages.filter(m => m.role === 'user').pop();
      if (!userMessage) {
        return res.status(400).json({
          error: {
            message: 'User message not found',
            type: 'invalid_request_error',
            code: 'user_message_required'
          }
        });
      }

      // Извлекаем Character ID
      const characterId = model.replace('character-', '').replace('character_', '');
      
      // Временный ответ для тестирования
      const testResponses = {
        'test': 'Тестовое соединение успешно установлено!',
        'default': `Привет! Я персонаж ${characterId}. Ваше сообщение: "${userMessage.content}". (Это тестовый ответ)`
      };
      
      const responseText = testResponses[characterId] || testResponses['default'];

      // Создаем OpenAI-совместимый ответ
      const response = {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        system_fingerprint: 'fp_' + characterId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: responseText
          },
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: userMessage.content.length,
          completion_tokens: responseText.length,
          total_tokens: userMessage.content.length + responseText.length
        }
      };

      // Если нужен streaming
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // Отправляем ответ по частям
        const words = responseText.split(' ');
        for (let i = 0; i < words.length; i++) {
          const chunk = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {
                content: words[i] + (i < words.length - 1 ? ' ' : '')
              },
              finish_reason: i === words.length - 1 ? 'stop' : null
            }]
          };
          
          res.write('data: ' + JSON.stringify(chunk) + '\n\n');
          await new Promise(r => setTimeout(r, 50));
        }
        
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.status(200).json(response);
      }
      
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({
        error: {
          message: error.message || 'Internal server error',
          type: 'internal_error'
        }
      });
    }
  } else {
    res.status(405).json({
      error: {
        message: `Method ${req.method} not allowed`,
        type: 'method_not_allowed'
      }
    });
  }
};
