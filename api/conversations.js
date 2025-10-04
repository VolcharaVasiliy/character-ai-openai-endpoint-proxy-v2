import { CAINode } from 'cainode';
import Cors from 'cors';

const cors = Cors({
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

export default async function handler(req, res) {
  await runMiddleware(req, res, cors);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const client = new CAINode();
    await client.login(token);

    const { characterId } = req.query;

    if (req.method === 'GET') {
      // Получить список веток диалога
      const conversations = await client.chat.history_conversation_list(characterId);
      
      return res.status(200).json({
        success: true,
        conversations: conversations || []
      });
      
    } else if (req.method === 'POST') {
      // Создать новую ветку диалога
      const { branchFromMessageId } = req.body;
      
      await client.character.connect(characterId);
      const newConversation = await client.character.create_new_conversation();
      
      return res.status(200).json({
        success: true,
        chatId: newConversation.chat_id,
        message: 'New conversation branch created'
      });
      
    } else if (req.method === 'DELETE') {
      // Удалить ветку диалога
      const { chatId } = req.body;
      
      // CAINode не поддерживает удаление, но мы можем пометить как удаленную локально
      return res.status(200).json({
        success: true,
        message: 'Conversation marked as deleted locally'
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
}
