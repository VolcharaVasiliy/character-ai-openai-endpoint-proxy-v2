const fetch = require('node-fetch');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

module.exports = async (req, res) => {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { token } = req.query;
  
  if (!token) {
    return res.status(400).json({ 
      error: 'Token required',
      usage: 'Add ?token=YOUR_TOKEN to the URL'
    });
  }

  try {
    // Тестируем токен
    const response = await fetch('https://beta.character.ai/chat/user/', {
      headers: {
        'Authorization': `Token ${token}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid token',
        status: response.status
      });
    }

    const data = await response.json();
    
    return res.status(200).json({
      success: true,
      message: 'Token is valid',
      user: data.user || {},
      info: {
        endpoint: `${req.headers.host}/api/chat/completions`,
        tokenFormat: 'accessToken:characterId:chatId',
        example: `${token}:CHAR_ID_HERE`
      }
    });
  } catch (error) {
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};
