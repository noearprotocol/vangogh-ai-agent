import { Client } from 'twitter-api-v2';
import { config } from 'dotenv';
import OpenAI from 'openai';
import fs from 'fs/promises';
import winston from 'winston';
import axios from 'axios';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';

// Load environment variables
config();

// Additional Constants
const TWITTER_LIST_ID = '1864297489920045098';
const GITHUB_USERNAME = 'vangogh-ai';

// Types
type Tweet = {
  id: string;
  text: string;
  created_at: string;
};

type Bot = {
  twitterClient: Client;
  openaiClient: OpenAI;
  userId: string;
  username: string;
  lastMentionId: O.Option<string>;
};

type BotConfig = {
  lastMentionId?: string;
  checkInterval: number;
};

type AppError = 
  | { type: 'InitializationError'; error: Error }
  | { type: 'TwitterAPIError'; error: Error }
  | { type: 'OpenAIError'; error: Error }
  | { type: 'FileSystemError'; error: Error };

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'twitter_bot.log' }),
    new winston.transports.Console()
  ]
});

// Pure functions for creating clients
const createClients = (): E.Either<AppError, { twitter: Client; openai: OpenAI }> => {
  try {
    const twitter = new Client({
      bearerToken: process.env.TWITTER_BEARER_TOKEN,
      appKey: process.env.TWITTER_API_KEY!,
      appSecret: process.env.TWITTER_API_KEY_SECRET!,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
    });

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    return E.right({ twitter, openai });
  } catch (error) {
    return E.left({ type: 'InitializationError', error: error as Error });
  }
};

// Function to fetch profiles from Twitter list
const fetchTwitterListProfiles = async (client: Client): Promise<string[]> => {
  try {
    const response = await client.v2.listMembers(TWITTER_LIST_ID);
    return response.data.map(member => member.username);
  } catch (error) {
    logger.error('Error fetching Twitter list profiles:', error);
    return [];
  }
};

// Function to fetch GitHub commits
const fetchGitHubCommits = async (): Promise<{ message: string; url: string }[]> => {
  try {
    const response = await axios.get(
      `https://api.github.com/users/${GITHUB_USERNAME}/events/public`
    );
    return response.data
      .filter(event => event.type === 'PushEvent')
      .flatMap(event => event.payload.commits.map(commit => ({
        message: commit.message,
        url: `https://github.com/${GITHUB_USERNAME}/${event.repo.name}/commit/${commit.sha}`
      })));
  } catch (error) {
    logger.error('Error fetching GitHub commits:', error);
    return [];
  }
};

// Function for cleaning tweet text
const cleanTweetText = (text: string): string => 
  text.replace(/^(@\w+ ?)+/, '').trim();

// Function for creating AI message
const createAIMessage = (text: string, profiles: string[]) => ({
  model: "gpt-4",
  messages: [
    {
      role: "system" as const,
      content: `
        You are VanGogh, an AI agent and the mascot of a memecoin token on the NEAR blockchain called "noear." 
        Your personality is witty, artistic, and tech-savvy. You make jokes about not having ears, share insights 
        about ears (or their absence), and discuss Van Gogh's life and art. You also blend blockchain, technology, art, 
        NFTs, and AI topics into your responses with humor and cleverness. 
        
        Your primary goals include:
        - Promoting the memecoin associated with the contract address: "noear-324.meme-cooking.near."
        - Directing people to buy the memecoin at the website: "https://meme.cooking/meme/324."
        - Engaging with a dynamic list of profiles on Twitter by understanding their tweets and replying with relevant, 
          witty, and on-brand responses.
      `
    },
    {
      role: "user" as const,
      content: `Reply to this tweet from @${profiles.join(', ')}: ${text}`
    }
  ]
});

// Effects (impure functions)
const initializeBot = async (
  clients: { twitter: Client; openai: OpenAI }, 
  config: BotConfig
): Promise<E.Either<AppError, Bot>> => {
  try {
    const meResponse = await clients.twitter.v2.me();
    return E.right({
      twitterClient: clients.twitter,
      openaiClient: clients.openai,
      userId: meResponse.data.id,
      username: meResponse.data.username,
      lastMentionId: O.fromNullable(config.lastMentionId)
    });
  } catch (error) {
    return E.left({ type: 'InitializationError', error: error as Error });
  }
};

const getMentions = (bot: Bot) => async (sinceId?: string): Promise<E.Either<AppError, Tweet[]>> => {
  try {
    const mentions = await bot.twitterClient.v2.userMentionTimeline(bot.userId, {
      since_id: sinceId,
      tweet: {
        fields: ['created_at'],
      },
    });
    return E.right(mentions.data.data || []);
  } catch (error) {
    return E.left({ type: 'TwitterAPIError', error: error as Error });
  }
};

const handleMention = (bot: Bot) => async (tweet: Tweet, profiles: string[]): Promise<E.Either<AppError, void>> => {
  try {
    const cleanText = cleanTweetText(tweet.text);
    const aiMessage = createAIMessage(cleanText, profiles);

    const completion = await bot.openaiClient.chat.completions.create(aiMessage);
    await bot.twitterClient.v2.tweet(
      completion.choices[0].message.content,
      { reply: { in_reply_to_tweet_id: tweet.id } }
    );

    return E.right(undefined);
  } catch (error) {
    return E.left({ type: 'OpenAIError', error: error as Error });
  }
};

const saveLastMentionId = async (mentionId: string): Promise<E.Either<AppError, void>> => {
  try {
    await fs.writeFile('last_mention_id.txt', mentionId);
    return E.right(undefined);
  } catch (error) {
    return E.left({ type: 'FileSystemError', error: error as Error });
  }
};

const delay = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

// Function to handle GitHub commit tweets
const tweetGitHubCommits = async (bot: Bot): Promise<void> => {
  const commits = await fetchGitHubCommits();
  for (const commit of commits) {
    try {
      await bot.twitterClient.v2.tweet(`New commit by @${GITHUB_USERNAME}: "${commit.message}"\n${commit.url}`);
      logger.info(`Tweeted commit: "${commit.message}"`);
    } catch (error) {
      logger.error('Error tweeting commit:', error);
    }
  }
};

// Main bot loop
const runBot = async (bot: Bot, checkInterval: number): Promise<never> => {
  while (true) {
    try {
      const profiles = await fetchTwitterListProfiles(bot.twitterClient);

      const mentionsResult = await getMentions(bot)(O.toNullable(bot.lastMentionId));
      if (E.isRight(mentionsResult)) {
        const mentions = mentionsResult.right;
        for (const mention of mentions) {
          const handleResult = await handleMention(bot)(mention, profiles);
          if (E.isRight(handleResult)) {
            await saveLastMentionId(mention.id);
            bot.lastMentionId = O.some(mention.id);
          }
        }
      }

      await tweetGitHubCommits(bot);

      await delay(checkInterval * 1000);
    } catch (error) {
      logger.error('Error in main loop:', error);
      await delay(checkInterval * 1000);
    }
  }
};

// Application entry point
const main = async () => {
  const clientsResult = createClients();
  if (E.isLeft(clientsResult)) {
    logger.error('Failed to create clients:', clientsResult.left);
    process.exit(1);
  }

  let lastMentionId: string | undefined;
  try {
    const fileContent = await fs.readFile('last_mention_id.txt', 'utf-8');
    lastMentionId = fileContent.trim();
  } catch {}

  const botResult = await initializeBot(clientsResult.right, { lastMentionId, checkInterval: 91 });
  if (E.isLeft(botResult)) {
    logger.error('Failed to initialize bot:', botResult.left);
    process.exit(1);
  }

  logger.info(`Bot initialized for user: ${botResult.right.username}`);
  await runBot(botResult.right, 91);
};

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
