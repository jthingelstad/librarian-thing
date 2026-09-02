import crypto from 'node:crypto';
import { DeleteItemCommand, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { dynamodb } from './aws-clients.mjs';
import { sha256Hex } from './oauth-store.mjs';
import { magicLinkBaseUrl } from './magic-link.mjs';
import { dynamoNumber, dynamoString, fromDynamoAttr } from './user-conversations.mjs';
import { getUserConversation } from './conversation-store.mjs';

// Share links pin content for a year: a link dropped in a newsletter must
// not rot on the 45-day conversation cadence. The share action re-stamps
// the conversation and turn TTLs to match (see conversation-routes.mts).
export const SHARE_TTL_SECONDS = 365 * 24 * 60 * 60;

const SHARE_TOKEN_PREFIX = 'shr_';
// prefix + 43 base64url chars from 32 random bytes.
const SHARE_TOKEN_RE = /^shr_[A-Za-z0-9_-]{43}$/;

export interface ConversationShare {
  subscriberHash: string;
  conversationId: string;
  sharedUpTo: string;
  createdAt: string;
  expiresAt: number;
}

export function generateShareToken() {
  return `${SHARE_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

export function validShareToken(value: unknown) {
  const text = String(value || '').trim();
  return SHARE_TOKEN_RE.test(text) ? text : '';
}

export function shareTokenHash(token: string) {
  return sha256Hex(token);
}

function sharePk(tokenHash: string) {
  return `share#${tokenHash}`;
}

export function shareUrl(token: string) {
  // Origin-absolute: the base env var carries the site origin, and a
  // relative join would inherit any path on it (a /signin/ default once
  // minted /signin/c/<token> links in production).
  return new URL(`/c/${token}`, magicLinkBaseUrl()).toString();
}

// The plaintext token lives only on the owner's conversation row (so the
// UI can re-show the link); the viewer-lookup row stores the sha256, the
// same at-rest posture as the OAuth store.
export async function putShare({
  token,
  subscriberHash,
  conversationId,
  sharedUpTo,
  now = new Date()
}: {
  token: string;
  subscriberHash: string;
  conversationId: string;
  sharedUpTo: string;
  now?: Date;
}) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is not configured');
  const expiresAt = Math.floor(now.getTime() / 1000) + SHARE_TTL_SECONDS;
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: dynamoString(sharePk(shareTokenHash(token))),
        sk: dynamoString('share'),
        item_type: dynamoString('conversation_share'),
        subscriber_hash: dynamoString(subscriberHash),
        conversation_id: dynamoString(conversationId),
        shared_up_to: dynamoString(sharedUpTo),
        created_at: dynamoString(now.toISOString()),
        ttl: dynamoNumber(expiresAt)
      }
    })
  );
  return expiresAt;
}

export async function getShare(token: string): Promise<ConversationShare | null> {
  const tableName = process.env.TABLE_NAME;
  const validToken = validShareToken(token);
  if (!tableName || !validToken) return null;
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: dynamoString(sharePk(shareTokenHash(validToken))), sk: dynamoString('share') }
    })
  );
  const item = response.Item;
  if (!item) return null;
  const expiresAt = Number(fromDynamoAttr(item.ttl) || 0);
  // DynamoDB TTL deletion lags; treat an expired row as gone.
  if (expiresAt && expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return {
    subscriberHash: String(fromDynamoAttr(item.subscriber_hash) || ''),
    conversationId: String(fromDynamoAttr(item.conversation_id) || ''),
    sharedUpTo: String(fromDynamoAttr(item.shared_up_to) || ''),
    createdAt: String(fromDynamoAttr(item.created_at) || ''),
    expiresAt
  };
}

export async function deleteShare(token: string) {
  const tableName = process.env.TABLE_NAME;
  const validToken = validShareToken(token);
  if (!tableName || !validToken) return;
  await dynamodb.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { pk: dynamoString(sharePk(shareTokenHash(validToken))), sk: dynamoString('share') }
    })
  );
}

export function shareRowKey(token: string) {
  return { pk: { S: sharePk(shareTokenHash(token)) }, sk: { S: 'share' } };
}

// The share snapshot both surfaces use: the /share/{token} public view
// and /chat's share_token continuation seeding. Honors sharedUpTo (turns
// shared later than the pin stay private) and the active-branch rule.
export async function loadSharedConversationSnapshot(
  token: string,
  deps: { dynamodb?: typeof dynamodb; tableName?: string; getShare?: typeof getShare } = {}
) {
  const validToken = validShareToken(token);
  if (!validToken) return null;
  const share = await (deps.getShare || getShare)(validToken);
  if (!share) return null;
  const result = await getUserConversation({
    dynamodb: deps.dynamodb || dynamodb,
    tableName: deps.tableName || process.env.TABLE_NAME,
    subscriberHash: share.subscriberHash,
    conversationId: share.conversationId,
    chainOnly: true
  });
  if (!result) return null;
  const messages = (result.messages || [])
    .filter(
      (message) =>
        String(message.content || '').trim() &&
        String(message.created_at || '') &&
        String(message.created_at) <= share.sharedUpTo
    )
    .map((message) =>
      message.role === 'assistant'
        ? {
            role: 'assistant' as const,
            content: String(message.content || ''),
            citations: Array.isArray(message.citations) ? message.citations : [],
            created_at: String(message.created_at || '')
          }
        : {
            role: 'user' as const,
            content: String(message.content || ''),
            created_at: String(message.created_at || '')
          }
    );
  return {
    share,
    title: String(result.conversation?.title || 'A Thingy conversation'),
    createdAt: String(result.conversation?.created_at || ''),
    messages
  };
}

// Bounded chat-context form of a shared snapshot: same trim rules as
// normal conversation history.
export function sharedSnapshotHistory(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  let chars = 0;
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const item of messages.slice(-16).reverse()) {
    const content = String(item.content || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 700);
    if (!content) continue;
    chars += content.length;
    if (chars > 9000) break;
    result.unshift({ role: item.role, content });
  }
  return result;
}
