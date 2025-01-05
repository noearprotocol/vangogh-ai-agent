import express from 'express';
import { config } from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';
import open from 'open';
import { OAuth } from 'oauth-1.0a';
import crypto from 'crypto';

// Load environment variables
config();

// Validate required environment variables
if (!process.env.TWITTER_API_KEY || !process.env.TWITTER_API_KEY_SECRET) {
  throw new Error('Missing Twitter API credentials in .env file');
}

// Types
interface OAuthTokens {
  oauth_token: string;
  oauth_token_secret: string;
}

// Constants
const PORT = process.env.PORT || 8000;
const CALLBACK_URL = `http://127.0.0.1:${PORT}/callback`;

// Initialize Express app
const app = express();

// Create OAuth 1.0a instance
const oauth = new OAuth({
  consumer: {
    key: process.env.TWITTER_API_KEY,
    secret: process.env.TWITTER_API_KEY_SECRET,
  },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string: string, key: string) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  },
});

// Initialize Twitter client
const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_KEY_SECRET,
});

let requestTokens: OAuthTokens | null = null;

// Routes
app.get('/', async (_, res) => {
  try {
    // Generate OAuth request tokens
    const tokens = await client.generateAuthLink(CALLBACK_URL, { linkMode: 'authorize' });
    requestTokens = {
      oauth_token: tokens.oauth_token,
      oauth_token_secret: tokens.oauth_token_secret,
    };

    // Open the authorization URL in the user's browser
    try {
      await open(tokens.url);
    } catch {
      console.log('Please open this URL manually:', tokens.url);
    }

    res.send('Authentication started. Check your browser.');
  } catch (error) {
    console.error('Error starting authentication:', error);
    res.status(500).send('Error starting authentication process');
  }
});

app.get('/callback', async (req, res) => {
  try {
    const { oauth_token, oauth_verifier } = req.query;

    if (!oauth_token || !oauth_verifier || !requestTokens) {
      throw new Error('Invalid callback parameters');
    }

    // Create a temporary Twitter client using request tokens
    const tempClient = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY,
      appSecret: process.env.TWITTER_API_KEY_SECRET,
      accessToken: requestTokens.oauth_token,
      accessSecret: requestTokens.oauth_token_secret,
    });

    // Exchange the verifier for access tokens
    const { accessToken, accessSecret } = await tempClient.login(oauth_verifier as string);

    // Log and instruct the user to save their tokens
    console.log('\n=== Save these tokens in your .env file ===');
    console.log(`ACCESS_TOKEN=${accessToken}`);
    console.log(`ACCESS_TOKEN_SECRET=${accessSecret}`);

    res.send('Authentication successful! Check your terminal for the access tokens.');
  } catch (error) {
    console.error('Error in callback:', error);
    res.status(500).send('Error completing authentication');
  }
});

// Function to start the server
const startServer = () => {
  console.log('Starting authentication process...');
  console.log('1. A browser window will open.');
  console.log('2. Log in with your bot account (not your developer account).');
  console.log('3. Authorize the application.');
  console.log('4. Copy the new access tokens to your .env file.');

  app.listen(PORT, () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
  });
};

// Graceful shutdown for the server
process.on('SIGINT', () => {
  console.log('Server shutting down...');
  process.exit();
});

// Start the server if this script is run directly
if (require.main === module) {
  startServer();
}

export { startServer };
