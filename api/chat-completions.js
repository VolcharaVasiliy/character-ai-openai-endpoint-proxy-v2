const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'X-Chat-Id, X-Character-Id'
};

// Кеш для хранения истории чатов
const chatHistories = new Map();

class CharacterAI {
  constructor(accessToken) {
    this.token = accessToken;
    this.baseURL = 'https://beta.character.ai';
  }

  async getHeaders() {
    return {
      'authorization': `Token ${this.token}`,
      'content-type': 'application/json',
      'accept': '*/*',
      'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'cache-control': 'no-cache',
      'origin': 'https://character.ai',
      'pragma': 'no-cache',
      'referer': 'https://character.ai/',
      'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    };
  }

  async createChat(characterId) {
    try {
      const headers = await this.getHeaders();
      
      const response = await fetch(`${this.baseURL}/chat/history/create/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          character_external_id: characterId,
          history_external_id: null
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Create chat error:', errorText);
        throw new Error(`Failed to create chat: ${response.status}`);
      }

      const data = await response.json();
      return data.external_id;
    } catch (error) {
      console.error('Error creating chat:', error);
      throw error;
    }
  }

  async continueChat(characterId, historyId) {
    try {
      const headers = await this.getHeaders();
      
      const response = await fetch(`${this.baseURL}/chat/history/continue/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          character_external_id: characterId,
          history_external_id: historyId
        })
      });

      if (!response.ok) {
        // Если не можем продолжить чат, создаем новый
        return await this.createChat(characterId);
      }

      const data = await response.json();
      return historyId;
    } catch (error) {
      console.error('Error continuing chat:', error);
      // Создаем новый чат если не можем продолжить
      return await this.createChat(characterId);
    }
  }

  async sendMessage(characterId, historyId, text) {
    try {
      const headers = await this.getHeaders();
      const tgt = characterId;
      
      // Используем streaming endpoint
      const response = await fetch(`${this.baseURL}/chat/streaming/`, {
        method: 'POST',
        headers: {
          ...headers,
          'accept': 'text/event-stream'
        },
        body: JSON.stringify({
          history_external_id: historyId,
          character_external_id: characterId,
          text: text,
          tgt: tgt,
          ranking_method: 'random',
          candidates_to_generate: 1,
          user_name: 'User',
          mock_response: false,
          staging: false,
          model_server_address: null,
          override_prefix: null,
          override_rank: null,
          rank_candidates: null,
          filter_candidates: null,
          prefix_limit: null,
          prefix_token_limit: null,
          livetune_coeff: null,
          parent_msg_id: null,
          initial_timeout: null,
          enable_tti: true,
          temperature: 1.0,
          top_p: null,
          base_model: 'c1.2'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Send message error:', errorText);
        throw new Error(`Failed to send message: ${response.status}`);
      }

      const responseText = await response.text();
      
      // Парсим streaming response
      const lines = responseText.split('\n');
      let finalReply = '';
      let lastData = null;
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6);
            if (jsonStr && jsonStr !== '[DONE]') {
              const data = JSON.parse(jsonStr);
              
              // Ищем текст ответа в разных местах
              if (data.replies && data.replies.length > 0) {
                finalReply = data.replies[0].text;
                lastData = data;
              } else if (data.text) {
                finalReply = data.text;
                lastData = data;
              } else if (data.final_text) {
                finalReply = data.final_text;
                lastData = data;
              }
            }
          } catch (e) {
            // Пропускаем строки, которые не являются JSON
            console.log('Non-JSON line:', line);
          }
        }
      }

      if (!finalReply) {
        // Если не нашли ответ в streaming, попробуем обычный endpoint
        return await this.sendMessageFallback(characterId, historyId, text);
      }

      return finalReply;

    } catch (error) {
      console.error('Error in sendMessage:', error);
      // Fallback на альтернативный метод
      return await this.sendMessageFallback(characterId, historyId, text);
    }
  }

  async sendMessageFallback(characterId, historyId, text) {
    try {
      const headers = await this.getHeaders();
      
      const response = await fetch(`${this.baseURL}/chat/character/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          history_external_id: historyId,
          character_external_id: characterId,
          text: text,
          enable_tti: true,
          num_candidates: 1,
          user_name: 'User'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Fallback failed: ${errorText}`);
      }

      const data = await response.json();
      
      if (data.replies && data.replies.length > 0) {
        return data.replies[0].text;
      } else if (data.text) {
        return data.text;
      }
      
      throw new Error('No reply in response');
      
    } catch (error) {
      console.error('Fallback error:', error);
      throw error;
    }
  }
}

module.exports = async (req, res) => {
  // Устанавливаем CORS заголовки
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

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
          message: 'Missing authorization header',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      });
    }

    const token = authorization.replace('Bearer ', '');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Парсим токен
    const [accessToken, characterId, chatId] = token.split(':');
    
    if (!accessToken || !characterId) {
      return res.status(400).json({ 
        error: {
          message: 'Invalid token format. Use: accessToken:characterId:chatId',
          type: 'invalid_request_error'
        }
      });
    }

    // Создаем клиент
    const client = new CharacterAI(accessToken);
    
    // Получаем или создаем историю чата
    let historyId = chatId;
    
    if (!historyId) {
      // Проверяем кеш
      const cacheKey = `${accessToken}_${characterId}`;
      historyId = chatHistories.get(cacheKey);
      
      if (!historyId) {
        // Создаем новый чат
        historyId = await client.createChat(characterId);
        chatHistories.set(cacheKey, historyId);
      }
    } else {
      // Продолжаем существующий чат
      historyId = await client.continueChat(characterId, historyId);
    }

    // Извлекаем сообщение пользователя
    const messages = body.messages || [];
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    
    if (!lastUserMessage) {
      return res.status(400).json({ 
        error: {
          message: 'No user message found',
          type: 'invalid_request_error'
        }
      });
    }

    // Отправляем сообщение
    const responseText = await client.sendMessage(
      characterId, 
      historyId, 
      lastUserMessage.content
    );

    // Формируем ответ OpenAI
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

    // Добавляем заголовки с информацией о чате
    res.setHeader('X-Chat-Id', historyId);
    res.setHeader('X-Character-Id', characterId);
    
    return res.status(200).json(openAIResponse);

  } catch (error) {
    console.error('Main error:', error);
    return res.status(500).json({ 
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error',
        details: error.toString()
      }
    });
  }
};
