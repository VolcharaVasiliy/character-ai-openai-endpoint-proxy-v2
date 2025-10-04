const CharacterAI = require('node_characterai');
const cors = require('cors');

const corsMiddleware = cors({ origin: '*' });

function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

module.exports = async (req, res) => {
  await runMiddleware(req, res, corsMiddleware);
  
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
    
    // Получаем список чатов
    const chats = await client.fetchRecentChats();
    
    return res.status(200).json({
      success: true,
      chats: chats || []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
