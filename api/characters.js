const CharacterAI = require('node_characterai');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

module.exports = async (req, res) => {
  // Устанавливаем CORS заголовки
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { token } = req.query;
  
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  try {
    const client = new CharacterAI();
    await client.authenticateWithToken(token);
    
    // Получаем информацию о пользователе
    const user = await client.fetchUser();
    
    return res.status(200).json({
      success: true,
      user: user || {},
      message: 'Token is valid'
    });
  } catch (error) {
    return res.status(500).json({ 
      error: error.message,
      success: false 
    });
  }
};
