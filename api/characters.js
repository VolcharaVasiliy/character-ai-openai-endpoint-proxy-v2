const fetch = require('node-fetch');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

module.exports = async (req, res) => {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { token, characterId } = req.query;
  
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  try {
    const headers = {
      'authorization': `Token ${token}`,
      'accept': 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    // Получаем историю чатов
    const historyUrl = characterId 
      ? `https://beta.character.ai/chat/character/histories/?character_external_id=${characterId}`
      : 'https://beta.character.ai/chat/user/';
      
    const response = await fetch(historyUrl, { headers });

    if (!response.ok) {
      const text = await response.text();
      console.error('Response text:', text);
      return res.status(response.status).json({ 
        error: 'Failed to fetch data',
        status: response.status,
        message: text.substring(0, 100)
      });
    }

    const contentType = response.headers.get('content-type');
    
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return res.status(200).json({
        success: true,
        data: data,
        histories: data.histories || []
      });
    } else {
      const text = await response.text();
      return res.status(200).json({
        success: true,
        message: 'Token is valid but response is not JSON',
        rawResponse: text.substring(0, 200)
      });
    }
    
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: error.message,
      success: false 
    });
  }
};
