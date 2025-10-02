const CharacterAI = require('node-character-ai');
const characterAI = new CharacterAI();

// Переменная для хранения истории чатов (простая реализация в памяти)
const chatHistories = new Map();

module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') {
        // Обработка pre-flight запросов CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(200).end();
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    const { authorization } = req.headers;
    const { model, messages } = req.body;

    if (!authorization || !authorization.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization header is missing or invalid.' });
    }

    const token = authorization.split(' ')[1];

    if (!model) {
        return res.status(400).json({ error: 'Character ID (model) is required.' });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'Messages are required.' });
    }

    try {
        await characterAI.authenticateWithToken(token);

        const lastUserMessage = messages[messages.length - 1].content;
        const characterId = model;

        // Получаем или создаем новую сессию чата
        let chat = chatHistories.get(characterId);
        if (!chat) {
            chat = await characterAI.createOrContinueChat(characterId);
            chatHistories.set(characterId, chat);
        }

        const response = await chat.sendAndAwaitResponse(lastUserMessage, true);

        res.status(200).json({
            choices: [{
                message: {
                    role: 'assistant',
                    content: response.text,
                },
            }],
        });

    } catch (error) {
        console.error(error);
        // Сбрасываем историю при ошибке, чтобы избежать проблем с сессией
        chatHistories.delete(model);
        res.status(500).json({ error: 'An error occurred while processing your request.', details: error.message });
    }
};
