import { CAINode } from 'cainode';
import Cors from 'cors';

const cors = Cors({
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

export default async function handler(req, res) {
  await runMiddleware(req, res, cors);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, timeout = 60 } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const client = new CAINode();
    
    const token = await client.generate_token(
      email, 
      timeout,
      () => console.log('Verification email sent'),
      () => console.log('Timeout reached')
    );

    if (token) {
      return res.status(200).json({ 
        success: true,
        token,
        message: 'Token generated successfully' 
      });
    } else {
      return res.status(408).json({ 
        success: false,
        error: 'Token generation timeout' 
      });
    }

  } catch (error) {
    console.error('Token generation error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate token',
      details: error.message 
    });
  }
}
