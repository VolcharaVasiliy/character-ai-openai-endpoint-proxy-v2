const CharacterAI = require("node_characterai");
const cors = require('cors');

const corsMiddleware = cors({
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  origin: '*'
});

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

// Локальное хранилище веток диалогов
const conversationBranches = new Map();

module.exports = async function handler(req, res) {
  await runMiddleware(req, res, corsMiddleware);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.replace('Bearer ', '');
  const userId = token.substring(0, 8);

  try {
    const { characterId } = req.query;

    if (req.method === 'GET') {
      // Получить список веток диалога
      const key = `${userId}:${characterId}`;
      const branches = conversationBranches.get(key) || [];
      
      return res.status(200).json({
        success: true,
        conversations: branches
      });
      
    } else if (req.method === 'POST') {
      // Создать новую ветку диалога
      const { parentChatId, messageId } = req.body;
      
      const characterAI = new CharacterAI();
      characterAI.requester.puppeteer = false;
      characterAI.requester.usePlus = false;
      
      await characterAI.authenticateWithToken(token);
      
      const newChat = await characterAI.createOrContinueChat(characterId);
      
      const key = `${userId}:${characterId}`;
      const branches = conversationBranches.get(key) || [];
      
      branches.push({
        chatId: newChat.externalId || Date.now().toString(),
        parentChatId,
        messageId,
        createdAt: new Date().toISOString()
      });
      
      conversationBranches.set(key, branches);
      
      return res.status(200).json({
        success: true,
        chatId: newChat.externalId,
        message: 'New conversation branch created'
      });
      
    } else if (req.method === 'DELETE') {
      // Удалить ветку диалога из локального хранилища
      const { chatId } = req.body;
      const key = `${userId}:${characterId}`;
      
      let branches = conversationBranches.get(key) || [];
      branches = branches.filter(b => b.chatId !== chatId);
      conversationBranches.set(key, branches);
      
      return res.status(200).json({
        success: true,
        message: 'Conversation branch deleted locally'
      });
      
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
  } catch (error) {
    console.error('Conversations API error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
};
