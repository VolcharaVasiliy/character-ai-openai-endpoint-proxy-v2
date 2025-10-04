import { CAINode } from 'cainode';
import Cors from 'cors';

const cors = require('cors');

const corsMiddleware = cors({
  methods: ['GET', 'POST', 'OPTIONS'],
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

module.exports = async function handler(req, res) {
  await runMiddleware(req, res, corsMiddleware);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Инструкция по получению токена
  const instructions = {
    success: true,
    instructions: [
      {
        step: 1,
        title: "Войдите в Character.AI",
        description: "Откройте https://character.ai и войдите в свой аккаунт"
      },
      {
        step: 2,
        title: "Откройте DevTools",
        description: "Нажмите F12 или Ctrl+Shift+I (Cmd+Option+I на Mac)"
      },
      {
        step: 3,
        title: "Перейдите в Application/Storage",
        description: "В DevTools найдите вкладку Application (Chrome) или Storage (Firefox)"
      },
      {
        step: 4,
        title: "Найдите Local Storage",
        description: "Раскройте Local Storage → https://character.ai"
      },
      {
        step: 5,
        title: "Найдите токен",
        description: "Найдите ключ, начинающийся с '@@auth0spajs@@'"
      },
      {
        step: 6,
        title: "Скопируйте access_token",
        description: "В значении этого ключа найдите поле 'access_token' и скопируйте его значение"
      }
    ],
    note: "Токен действителен в течение 1 года. Храните его в безопасности!"
  };

  return res.status(200).json(instructions);
};
