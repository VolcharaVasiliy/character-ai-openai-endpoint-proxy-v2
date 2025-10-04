module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  res.status(200).json({
    instructions: [
      "1. Откройте Character.AI (https://character.ai)",
      "2. Авторизуйтесь в своем аккаунте",
      "3. Откройте DevTools (F12)",
      "4. Перейдите в Application → Local Storage → https://character.ai",
      "5. Найдите ключ, начинающийся с '@@auth0spajs@@'",
      "6. В значении найдите поле 'body' → 'access_token'",
      "7. Скопируйте значение access_token",
      "8. Это и есть ваш токен для API"
    ],
    keyPath: "@@auth0spajs@@::dyD3gE281MqgISG7FuIXYhL2WEknqZzv::https://auth0.character.ai/::openid profile email offline_access",
    note: "Токен действителен примерно 1-2 недели"
  });
};
