class CharacterAI {
  constructor() {
    this.baseUrl = 'https://beta.character.ai/chat/';
  }

  async sendMessage({ characterId, message, token }) {
    // Store history in localStorage for persistence
    const historyKey = `chat_history_${characterId}`;
    const history = this.getHistory(historyKey);

    const response = await fetch(`${this.baseUrl}conversation/messaging/create/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${token}`
      },
      body: JSON.stringify({
        character_id: characterId,
        text: message,
        history: history
      })
    });

    if (!response.ok) {
      throw new Error('Character.ai API error');
    }

    const data = await response.json();
    
    // Save new history
    this.saveHistory(historyKey, data.history);

    return {
      text: data.response,
      history: data.history
    };
  }

  getHistory(key) {
    if (typeof window === 'undefined') return [];
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : [];
  }

  saveHistory(key, history) {
    if (typeof window === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(history));
  }
}

export const characterAI = new CharacterAI();
