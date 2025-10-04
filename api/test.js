const fetch = require('node-fetch');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

module.exports = async (req, res) => {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { token } = req.query;
  
  if (!token) {
    return res.status(400).json({ 
      error: 'Token required',
      usage: '?token=YOUR_TOKEN'
    });
  }

  try {
    const response = await fetch('https://beta.character.ai/chat/user/', {
      headers: {
        'authorization': `Token ${token}`,
        'accept': 'application/json'
      }
    });

    const text = await response.text();
    
    if (response.ok) {
      try {
        const data = JSON.parse(text);
        return res.status(200).json({
          success: true,
          message: 'Token is valid',
          user: data.user || {},
          authenticated: true
        });
      } catch (e) {
        return res.status(200).json({
          success: true,
          message: 'Token seems valid',
          authenticated: true,
          raw: text.substring(0, 100)
        });
      }
    } else {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid token',
        status: response.status,
        message: text.substring(0, 100)
      });
    }
  } catch (error) {
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};
