import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { dynamodb } from './aws-clients.mjs';
import { logEvent } from './logging.mjs';
import { disconnectMcpConnection, listMcpConnections } from './mcp-connections.mjs';
import {
  createClient,
  deleteClient,
  OAUTH_SCOPES,
  oauthIssuer,
  peekClient,
  sanitizeClientName,
  validClientId,
  validRedirectUri
} from './oauth-store.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { dynamoNumber, dynamoString, userConversationPk } from './user-conversations.mjs';

// Apps a reader set up by hand from Thingy's account panel (contract 4.15.0,
// /memory actions mcp_clients, mcp_register_client and mcp_delete_client).
//
// Some MCP clients - AWS DevOps Agent's three-legged OAuth, for one - do no
// dynamic registration: they show a callback URL and ask for a client ID,
// the authorization and token URLs, and a scope. The reader pastes that
// callback here, Thingy registers a public client for it, and the panel
// shows every value the app's form asks for. The client row carries the
// reader's hash (owner_hash), so only that reader can authorize it, and a
// row in the reader's partition (user#<sub>, mcpclient#<client id>) lists
// it. The client row keeps its one-year ttl, refreshed on use; a listed
// client whose row has lapsed is dropped from the list and its panel row
// deleted.

type Item = Record<string, AttributeValue>;

const CLIENT_SK_PREFIX = 'mcpclient#';
// A person sets up a handful of apps, not dozens.
export const MAX_READER_CLIENTS = 10;
const REGISTER_RATE_LIMIT_MAX = 10;

export interface McpRegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
  // Live connections made through this client.
  connection_count: number;
  settings: McpClientSettings;
}

// What the app's authorization form asks for. No client secret: the client
// is public and PKCE (S256) is required.
export interface McpClientSettings {
  client_id: string;
  client_secret: string;
  authorization_url: string;
  token_url: string;
  mcp_url: string;
  scope: string;
  pkce: boolean;
}

function tableName() {
  const value = process.env.TABLE_NAME;
  if (!value) throw new Error('TABLE_NAME is required');
  return value;
}

function isoFromSeconds(seconds: number) {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
}

function itemString(item: Item, name: string) {
  return String(item[name]?.S || '');
}

function clientKey(subscriberHash: string, clientId: string) {
  return {
    pk: dynamoString(userConversationPk(subscriberHash)),
    sk: dynamoString(`${CLIENT_SK_PREFIX}${clientId}`)
  };
}

export function mcpClientSettings(clientId: string): McpClientSettings {
  const issuer = oauthIssuer();
  return {
    client_id: clientId,
    client_secret: '',
    authorization_url: `${issuer}/authorize`,
    token_url: `${issuer}/token`,
    mcp_url: `${issuer}/mcp`,
    scope: OAUTH_SCOPES.join(' '),
    pkce: true
  };
}

async function clientRows(subscriberHash: string): Promise<Item[]> {
  const response = await dynamodb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': dynamoString(userConversationPk(subscriberHash)),
        ':prefix': dynamoString(CLIENT_SK_PREFIX)
      }
    })
  );
  return response.Items || [];
}

/** The reader's registered apps, newest first. Lapsed clients are cleaned up. */
export async function listReaderClients(subscriberHash: string): Promise<McpRegisteredClient[]> {
  const [rows, connections] = await Promise.all([clientRows(subscriberHash), listMcpConnections(subscriberHash)]);
  const listed = await Promise.all(
    rows.map(async (item) => {
      const clientId = itemString(item, 'client_id');
      const client = await peekClient(clientId);
      if (!client || client.ownerHash !== subscriberHash) {
        await dynamodb.send(
          new DeleteItemCommand({ TableName: tableName(), Key: clientKey(subscriberHash, clientId) })
        );
        return null;
      }
      return {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uri: client.redirectUris[0] || '',
        created_at: isoFromSeconds(client.createdAt),
        expires_at: isoFromSeconds(client.expiresAt),
        connection_count: connections.filter((connection) => connection.client_id === client.clientId).length,
        settings: mcpClientSettings(client.clientId)
      };
    })
  );
  return listed
    .filter((client): client is McpRegisteredClient => client !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export type RegisterReaderClientResult =
  | { ok: true; client: McpRegisteredClient }
  | { ok: false; reason: 'invalid_name' | 'invalid_redirect_uri' | 'too_many' | 'rate_limited' };

/** Register a public client for one of the reader's apps. */
export async function registerReaderClient(
  subscriberHash: string,
  { clientName, redirectUri }: { clientName: unknown; redirectUri: unknown }
): Promise<RegisterReaderClientResult> {
  const name = sanitizeClientName(clientName);
  if (!name) return { ok: false, reason: 'invalid_name' };
  const uri = validRedirectUri(redirectUri);
  if (!uri) return { ok: false, reason: 'invalid_redirect_uri' };
  if (!(await checkRateLimit(`oauth#reader-register:${subscriberHash}`, REGISTER_RATE_LIMIT_MAX))) {
    return { ok: false, reason: 'rate_limited' };
  }
  const existing = await listReaderClients(subscriberHash);
  if (existing.length >= MAX_READER_CLIENTS) return { ok: false, reason: 'too_many' };
  const client = await createClient({ clientName: name, redirectUris: [uri], ownerHash: subscriberHash });
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: {
        ...clientKey(subscriberHash, client.clientId),
        item_type: dynamoString('mcp_registered_client'),
        client_id: dynamoString(client.clientId),
        created_at: dynamoNumber(client.createdAt)
      }
    })
  );
  logEvent('info', 'mcp_reader_client_registered', { subscriber_hash: subscriberHash, client_id: client.clientId });
  return {
    ok: true,
    client: {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uri: uri,
      created_at: isoFromSeconds(client.createdAt),
      expires_at: isoFromSeconds(client.expiresAt),
      connection_count: 0,
      settings: mcpClientSettings(client.clientId)
    }
  };
}

/**
 * Delete one of the reader's apps: its connections are disconnected first
 * (so no token outlives the client), then the client and the panel row.
 * The id must name a row in the reader's own partition.
 */
export async function deleteReaderClient(subscriberHash: string, clientId: unknown) {
  const id = validClientId(clientId);
  if (!id) return { ok: false as const, reason: 'invalid' as const };
  const key = clientKey(subscriberHash, id);
  const loaded = await dynamodb.send(new GetItemCommand({ TableName: tableName(), Key: key }));
  if (!loaded.Item) return { ok: false as const, reason: 'not_found' as const };
  const client = await peekClient(id);
  if (client && client.ownerHash !== subscriberHash) {
    // A panel row pointing at someone else's client cannot happen through
    // these doors; drop the row and leave the client alone.
    await dynamodb.send(new DeleteItemCommand({ TableName: tableName(), Key: key }));
    return { ok: false as const, reason: 'not_found' as const };
  }
  const connections = await listMcpConnections(subscriberHash);
  for (const connection of connections.filter((entry) => entry.client_id === id)) {
    await disconnectMcpConnection(subscriberHash, connection.id);
  }
  if (client) await deleteClient(id);
  await dynamodb.send(new DeleteItemCommand({ TableName: tableName(), Key: key }));
  logEvent('info', 'mcp_reader_client_deleted', { subscriber_hash: subscriberHash, client_id: id });
  return { ok: true as const };
}

/** Delete every app the reader registered (profile deletion). */
export async function deleteAllReaderClients(subscriberHash: string) {
  const rows = await clientRows(subscriberHash);
  for (const item of rows) {
    const id = validClientId(itemString(item, 'client_id'));
    if (!id) continue;
    const client = await peekClient(id);
    if (client?.ownerHash === subscriberHash) await deleteClient(id);
  }
  return rows.length;
}
