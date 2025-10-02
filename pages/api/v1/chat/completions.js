import { characterAI } from '../../../lib/characterai';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, model, stream } = req.body;
    const token = req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const lastMessage = messages[messages.length - 1].content;
    
    const response = await characterAI.sendMessage({
      characterId: model, // Using model field as character ID
      message: lastMessage,
      token: token
    });

    return res.status(200).json({
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      },
      choices: [
        {
          message: {
            role: 'assistant',
            content: response.text
          },
          finish_reason: 'stop',
          index: 0
        }
      ]
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
