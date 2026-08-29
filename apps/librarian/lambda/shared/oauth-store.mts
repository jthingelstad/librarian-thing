import crypto from 'node:crypto';
import { DeleteItemCommand, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { dynamodb } from './aws-clients.mjs';
import { errorFields, logEvent } from './logging.mjs';
import { dynamoNumber, dynamoString } from './user-conversations.mjs';

// OAuth 2.1 authorization-server storage for the Librarian MCP surface.
// Everything lives in the shared single table (TABLE_NAME, pk/sk + ttl).
// Secrets (tokens, codes) are stored as sha256 hex of the full string only.

export const OAUTH_SCOPES = ['archive:read'];
export const ACCESS_TOKEN_PREFIX = 'lat_';
export const REFRESH_TOKEN_PREFIX = 'lrt_';
export const AUTH_CODE_PREFIX = 'lac_';

export const CLIENT_TTL_SECONDS = 365 * 24 * 60 * 60;
export const PENDING_TTL_SECONDS = 600;
export const AUTH_CODE_TTL_SECONDS = 300;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const MAX_REDIRECT_URIS = 5;
const MAX_STATE_LENGTH = 512;

export type OauthPendingStatus = 'awaiting_email' | 'awaiting_code' | 'verified';

export interface OauthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export interface OauthPending {
  id: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  email: string;
  subscriberHash: string;
  entitlements: string[];
  status: OauthPendingStatus;
  createdAt: number;
  expiresAt: number;
}

export interface OauthGrant {
  clientId: string;
  subscriberHash: string;
  entitlements: string[];
  scope: string;
}

export interface OauthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  familyId: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested against the dist build)
// ---------------------------------------------------------------------------

export function sha256Hex(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateSecret(prefix: string) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

export function generateAccessToken() {
  return generateSecret(ACCESS_TOKEN_PREFIX);
}

export function generateRefreshToken() {
  return generateSecret(REFRESH_TOKEN_PREFIX);
}

export function generateAuthCode() {
  return generateSecret(AUTH_CODE_PREFIX);
}

export function generateClientId() {
  // 24 base64url chars from 18 random bytes; matches CLIENT_ID_RE.
  return crypto.randomBytes(18).toString('base64url');
}

export function generateOpaqueId() {
  return crypto.randomBytes(18).toString('base64url');
}

export function validClientId(value: unknown) {
  const raw = String(value || '').trim();
  return CLIENT_ID_RE.test(raw) ? raw : '';
}

export function sanitizeClientName(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\P{C}]/gu, '')
    .replace(/[<>&"']/g, '')
    .trim()
    .slice(0, 100);
}

// Absolute https URLs, or http on localhost / 127.0.0.1 (any port) for local
// MCP clients. No fragments (RFC 6749 3.1.2).
export function validRedirectUri(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.hash) return '';
  if (url.username || url.password) return '';
  if (url.protocol === 'https:') return raw;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return raw;
  return '';
}

export function validateRedirectUris(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REDIRECT_URIS) return null;
  const uris: string[] = [];
  for (const entry of value) {
    const uri = validRedirectUri(entry);
    if (!uri) return null;
    if (!uris.includes(uri)) uris.push(uri);
  }
  return uris;
}

export function validState(value: unknown) {
  const raw = String(value ?? '');
  return raw.length <= MAX_STATE_LENGTH ? raw : '';
}

export function validCodeChallenge(value: unknown) {
  const raw = String(value || '').trim();
  return CODE_CHALLENGE_RE.test(raw) ? raw : '';
}

export function validCodeVerifier(value: unknown) {
  const raw = String(value || '').trim();
  return CODE_VERIFIER_RE.test(raw) ? raw : '';
}

// The requested scope must be a subset of what we support. Empty request
// defaults to the full supported scope.
export function normalizeScope(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return OAUTH_SCOPES.join(' ');
  const requested = raw.split(/\s+/);
  const unique = Array.from(new Set(requested));
  if (unique.some((scope) => !OAUTH_SCOPES.includes(scope))) return '';
  return unique.join(' ');
}

export function verifyPkce(codeVerifier: unknown, codeChallenge: unknown) {
  const verifier = validCodeVerifier(codeVerifier);
  const challenge = String(codeChallenge || '');
  if (!verifier || !BASE64URL_RE.test(challenge)) return false;
  const derived = crypto.createHash('sha256').update(verifier).digest('base64url');
  const expected = Buffer.from(derived);
  const actual = Buffer.from(challenge);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// DynamoDB records
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>;

function tableName() {
  const value = process.env.TABLE_NAME;
  if (!value) throw new Error('TABLE_NAME is required');
  return value;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function itemString(item: Item | null | undefined, name: string) {
  return String(item?.[name]?.S || '');
}

function itemNumber(item: Item | null | undefined, name: string) {
  return Number(item?.[name]?.N || 0);
}

function itemJsonList(item: Item | null | undefined, name: string): string[] {
  try {
    const parsed: unknown = JSON.parse(itemString(item, name) || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function getRow(pk: string, sk: string) {
  const loaded = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName(),
      Key: { pk: dynamoString(pk), sk: dynamoString(sk) }
    })
  );
  return loaded.Item || null;
}

// --- Clients ---------------------------------------------------------------

export async function createClient({
  clientName,
  redirectUris
}: {
  clientName: string;
  redirectUris: string[];
}): Promise<OauthClient> {
  const clientId = generateClientId();
  const createdAt = nowSeconds();
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: {
        pk: dynamoString(`oauthclient#${clientId}`),
        sk: dynamoString('client'),
        client_id: dynamoString(clientId),
        client_name: dynamoString(clientName),
        redirect_uris: dynamoString(JSON.stringify(redirectUris)),
        created_at: dynamoNumber(createdAt),
        ttl: dynamoNumber(createdAt + CLIENT_TTL_SECONDS)
      },
      ConditionExpression: 'attribute_not_exists(pk)'
    })
  );
  logEvent('info', 'oauth_client_registered', { client_id: clientId, redirect_uri_count: redirectUris.length });
  return { clientId, clientName, redirectUris, createdAt };
}

export async function getClient(clientId: string): Promise<OauthClient | null> {
  const id = validClientId(clientId);
  if (!id) return null;
  const item = await getRow(`oauthclient#${id}`, 'client');
  if (!item) return null;
  // Refresh the one-year ttl on use so active clients never expire.
  try {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { pk: dynamoString(`oauthclient#${id}`), sk: dynamoString('client') },
        UpdateExpression: 'SET #ttl = :ttl',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':ttl': dynamoNumber(nowSeconds() + CLIENT_TTL_SECONDS) }
      })
    );
  } catch (error) {
    logEvent('warning', 'oauth_client_ttl_refresh_failed', errorFields(error, { client_id: id }));
  }
  return {
    clientId: itemString(item, 'client_id'),
    clientName: itemString(item, 'client_name'),
    redirectUris: itemJsonList(item, 'redirect_uris'),
    createdAt: itemNumber(item, 'created_at')
  };
}

// --- Pending authorizations ------------------------------------------------

export async function createPendingAuthorization({
  clientId,
  redirectUri,
  scope,
  state,
  codeChallenge
}: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): Promise<OauthPending> {
  const id = generateOpaqueId();
  const createdAt = nowSeconds();
  const expiresAt = createdAt + PENDING_TTL_SECONDS;
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: {
        pk: dynamoString(`oauthpending#${id}`),
        sk: dynamoString('pending'),
        client_id: dynamoString(clientId),
        redirect_uri: dynamoString(redirectUri),
        scope: dynamoString(scope),
        state: dynamoString(state),
        code_challenge: dynamoString(codeChallenge),
        code_challenge_method: dynamoString('S256'),
        email: dynamoString(''),
        subscriber_hash: dynamoString(''),
        entitlements: dynamoString('[]'),
        pending_status: dynamoString('awaiting_email'),
        created_at: dynamoNumber(createdAt),
        expires_at: dynamoNumber(expiresAt),
        ttl: dynamoNumber(expiresAt)
      },
      ConditionExpression: 'attribute_not_exists(pk)'
    })
  );
  return {
    id,
    clientId,
    redirectUri,
    scope,
    state,
    codeChallenge,
    codeChallengeMethod: 'S256',
    email: '',
    subscriberHash: '',
    entitlements: [],
    status: 'awaiting_email',
    createdAt,
    expiresAt
  };
}

export async function getPending(id: unknown): Promise<OauthPending | null> {
  const raw = String(id || '').trim();
  if (!BASE64URL_RE.test(raw) || raw.length < 16 || raw.length > 64) return null;
  const item = await getRow(`oauthpending#${raw}`, 'pending');
  if (!item) return null;
  const expiresAt = itemNumber(item, 'expires_at');
  if (expiresAt < nowSeconds()) return null;
  const status = itemString(item, 'pending_status');
  if (status !== 'awaiting_email' && status !== 'awaiting_code' && status !== 'verified') return null;
  return {
    id: raw,
    clientId: itemString(item, 'client_id'),
    redirectUri: itemString(item, 'redirect_uri'),
    scope: itemString(item, 'scope'),
    state: itemString(item, 'state'),
    codeChallenge: itemString(item, 'code_challenge'),
    codeChallengeMethod: 'S256',
    email: itemString(item, 'email'),
    subscriberHash: itemString(item, 'subscriber_hash'),
    entitlements: itemJsonList(item, 'entitlements'),
    status,
    createdAt: itemNumber(item, 'created_at'),
    expiresAt
  };
}

export async function updatePending(
  id: string,
  fields: { email?: string; subscriberHash?: string; entitlements?: string[]; status: OauthPendingStatus }
) {
  const names: Record<string, string> = { '#pending_status': 'pending_status', '#expires_at': 'expires_at' };
  const values: Item = {
    ':pending_status': dynamoString(fields.status),
    ':now': dynamoNumber(nowSeconds())
  };
  const sets = ['#pending_status = :pending_status'];
  if (fields.email !== undefined) {
    names['#email'] = 'email';
    values[':email'] = dynamoString(fields.email);
    sets.push('#email = :email');
  }
  if (fields.subscriberHash !== undefined) {
    names['#subscriber_hash'] = 'subscriber_hash';
    values[':subscriber_hash'] = dynamoString(fields.subscriberHash);
    sets.push('#subscriber_hash = :subscriber_hash');
  }
  if (fields.entitlements !== undefined) {
    names['#entitlements'] = 'entitlements';
    values[':entitlements'] = dynamoString(JSON.stringify(fields.entitlements));
    sets.push('#entitlements = :entitlements');
  }
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: { pk: dynamoString(`oauthpending#${id}`), sk: dynamoString('pending') },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(pk) AND #expires_at >= :now',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    })
  );
}

export async function deletePending(id: string) {
  await dynamodb.send(
    new DeleteItemCommand({
      TableName: tableName(),
      Key: { pk: dynamoString(`oauthpending#${id}`), sk: dynamoString('pending') }
    })
  );
}

// --- Authorization codes ---------------------------------------------------

// Snapshot the verified pending authorization into a single-use code row.
export function buildAuthCodeItem(pending: OauthPending, codeHash: string, createdAt = nowSeconds()): Item {
  const expiresAt = createdAt + AUTH_CODE_TTL_SECONDS;
  return {
    pk: dynamoString(`oauthcode#${codeHash}`),
    sk: dynamoString('code'),
    client_id: dynamoString(pending.clientId),
    redirect_uri: dynamoString(pending.redirectUri),
    scope: dynamoString(pending.scope),
    code_challenge: dynamoString(pending.codeChallenge),
    code_challenge_method: dynamoString('S256'),
    subscriber_hash: dynamoString(pending.subscriberHash),
    entitlements: dynamoString(JSON.stringify(pending.entitlements)),
    created_at: dynamoNumber(createdAt),
    expires_at: dynamoNumber(expiresAt),
    ttl: dynamoNumber(expiresAt)
  };
}

export async function createAuthCode(pending: OauthPending) {
  const code = generateAuthCode();
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: buildAuthCodeItem(pending, sha256Hex(code)),
      ConditionExpression: 'attribute_not_exists(pk)'
    })
  );
  return code;
}

export interface RedeemedAuthCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  subscriberHash: string;
  entitlements: string[];
}

// Single-use redemption: the conditional used_at update mirrors the
// magic-link redeem pattern so a raced second redemption loses.
export async function redeemAuthCode(code: unknown): Promise<RedeemedAuthCode | null> {
  const raw = String(code || '').trim();
  if (!raw.startsWith(AUTH_CODE_PREFIX) || !BASE64URL_RE.test(raw.slice(AUTH_CODE_PREFIX.length)) || raw.length > 128) {
    return null;
  }
  const codeHash = sha256Hex(raw);
  const key = { pk: dynamoString(`oauthcode#${codeHash}`), sk: dynamoString('code') };
  const now = nowSeconds();
  try {
    const updated = await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: key,
        UpdateExpression: 'SET #used_at = :used_at',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#used_at) AND #expires_at >= :now',
        ExpressionAttributeNames: { '#used_at': 'used_at', '#expires_at': 'expires_at' },
        ExpressionAttributeValues: { ':used_at': dynamoNumber(now), ':now': dynamoNumber(now) },
        ReturnValues: 'ALL_NEW'
      })
    );
    const item = updated.Attributes || null;
    if (!item) return null;
    return {
      clientId: itemString(item, 'client_id'),
      redirectUri: itemString(item, 'redirect_uri'),
      scope: itemString(item, 'scope'),
      codeChallenge: itemString(item, 'code_challenge'),
      subscriberHash: itemString(item, 'subscriber_hash'),
      entitlements: itemJsonList(item, 'entitlements')
    };
  } catch {
    logEvent('info', 'oauth_code_redeem_rejected', { code_hash_prefix: codeHash.slice(0, 10) });
    return null;
  }
}

// --- Tokens ----------------------------------------------------------------

async function putAccessToken(accessToken: string, grant: OauthGrant, now: number) {
  const expiresAt = now + ACCESS_TOKEN_TTL_SECONDS;
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: {
        pk: dynamoString(`oauthaccess#${sha256Hex(accessToken)}`),
        sk: dynamoString('access'),
        client_id: dynamoString(grant.clientId),
        subscriber_hash: dynamoString(grant.subscriberHash),
        entitlements: dynamoString(JSON.stringify(grant.entitlements)),
        scope: dynamoString(grant.scope),
        created_at: dynamoNumber(now),
        expires_at: dynamoNumber(expiresAt),
        ttl: dynamoNumber(expiresAt)
      },
      ConditionExpression: 'attribute_not_exists(pk)'
    })
  );
}

async function putRefreshToken(refreshToken: string, grant: OauthGrant, familyId: string, now: number) {
  const expiresAt = now + REFRESH_TOKEN_TTL_SECONDS;
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName(),
      Item: {
        pk: dynamoString(`oauthrefresh#${sha256Hex(refreshToken)}`),
        sk: dynamoString('refresh'),
        client_id: dynamoString(grant.clientId),
        subscriber_hash: dynamoString(grant.subscriberHash),
        entitlements: dynamoString(JSON.stringify(grant.entitlements)),
        scope: dynamoString(grant.scope),
        family_id: dynamoString(familyId),
        created_at: dynamoNumber(now),
        expires_at: dynamoNumber(expiresAt),
        ttl: dynamoNumber(expiresAt)
      },
      ConditionExpression: 'attribute_not_exists(pk)'
    })
  );
}

// No GSI exists, so family membership lives on a family row: every refresh
// hash ever minted for the family is appended here, and reuse detection
// deletes them all.
async function appendFamilyMember(familyId: string, refreshHash: string, now: number) {
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName(),
      Key: { pk: dynamoString(`oauthfamily#${familyId}`), sk: dynamoString('family') },
      UpdateExpression:
        'SET member_hashes = list_append(if_not_exists(member_hashes, :empty), :member), #ttl = :ttl, created_at = if_not_exists(created_at, :now)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':empty': { L: [] },
        ':member': { L: [dynamoString(refreshHash)] },
        ':ttl': dynamoNumber(now + REFRESH_TOKEN_TTL_SECONDS),
        ':now': dynamoNumber(now)
      }
    })
  );
}

async function revokeRefreshFamily(familyId: string) {
  const table = tableName();
  const familyKey = { pk: dynamoString(`oauthfamily#${familyId}`), sk: dynamoString('family') };
  const familyRow = await getRow(`oauthfamily#${familyId}`, 'family');
  const members = (familyRow?.member_hashes?.L || []).map((entry) => String(entry.S || '')).filter(Boolean);
  for (const memberHash of members) {
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: table,
        Key: { pk: dynamoString(`oauthrefresh#${memberHash}`), sk: dynamoString('refresh') }
      })
    );
  }
  await dynamodb.send(new DeleteItemCommand({ TableName: table, Key: familyKey }));
  logEvent('warning', 'oauth_refresh_family_revoked', { family_id: familyId, member_count: members.length });
}

export async function mintTokens(grant: OauthGrant, familyId = generateOpaqueId()): Promise<OauthTokens> {
  const now = nowSeconds();
  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();
  await putAccessToken(accessToken, grant, now);
  await putRefreshToken(refreshToken, grant, familyId, now);
  await appendFamilyMember(familyId, sha256Hex(refreshToken), now);
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope: grant.scope, familyId };
}

export type RefreshResult =
  { status: 'invalid' } | { status: 'reuse_revoked' } | { status: 'ok'; tokens: OauthTokens; grant: OauthGrant };

export async function redeemRefreshToken(refreshToken: unknown, clientId: string): Promise<RefreshResult> {
  const raw = String(refreshToken || '').trim();
  if (
    !raw.startsWith(REFRESH_TOKEN_PREFIX) ||
    !BASE64URL_RE.test(raw.slice(REFRESH_TOKEN_PREFIX.length)) ||
    raw.length > 128
  ) {
    return { status: 'invalid' };
  }
  const refreshHash = sha256Hex(raw);
  const item = await getRow(`oauthrefresh#${refreshHash}`, 'refresh');
  if (!item) return { status: 'invalid' };
  const now = nowSeconds();
  const familyId = itemString(item, 'family_id');
  if (itemNumber(item, 'expires_at') < now) return { status: 'invalid' };
  if (itemString(item, 'client_id') !== clientId) {
    logEvent('warning', 'oauth_refresh_client_mismatch', { family_id: familyId });
    return { status: 'invalid' };
  }
  if (itemString(item, 'rotated_to')) {
    // This refresh token was already rotated: someone is replaying an old
    // token. Revoke the whole family (RFC 9700 4.14.2).
    await revokeRefreshFamily(familyId);
    return { status: 'reuse_revoked' };
  }
  const grant: OauthGrant = {
    clientId,
    subscriberHash: itemString(item, 'subscriber_hash'),
    entitlements: itemJsonList(item, 'entitlements'),
    scope: itemString(item, 'scope')
  };
  const newRefreshToken = generateRefreshToken();
  try {
    // Mark the old token rotated before the successor exists anywhere. A
    // raced parallel redemption loses this conditional write and is treated
    // as reuse.
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: { pk: dynamoString(`oauthrefresh#${refreshHash}`), sk: dynamoString('refresh') },
        UpdateExpression: 'SET rotated_to = :rotated_to, rotated_at = :now',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(rotated_to)',
        ExpressionAttributeValues: {
          ':rotated_to': dynamoString(sha256Hex(newRefreshToken)),
          ':now': dynamoNumber(now)
        }
      })
    );
  } catch {
    await revokeRefreshFamily(familyId);
    return { status: 'reuse_revoked' };
  }
  const accessToken = generateAccessToken();
  await putAccessToken(accessToken, grant, now);
  await putRefreshToken(newRefreshToken, grant, familyId, now);
  await appendFamilyMember(familyId, sha256Hex(newRefreshToken), now);
  return {
    status: 'ok',
    tokens: {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      scope: grant.scope,
      familyId
    },
    grant
  };
}

export interface AccessTokenContext {
  subscriberHash: string;
  entitlements: string[];
  scope: string;
  clientId: string;
}

export async function validateAccessToken(token: unknown): Promise<AccessTokenContext | null> {
  const raw = String(token || '').trim();
  if (
    !raw.startsWith(ACCESS_TOKEN_PREFIX) ||
    !BASE64URL_RE.test(raw.slice(ACCESS_TOKEN_PREFIX.length)) ||
    raw.length > 128
  ) {
    return null;
  }
  const item = await getRow(`oauthaccess#${sha256Hex(raw)}`, 'access');
  if (!item) return null;
  if (itemNumber(item, 'expires_at') < nowSeconds()) return null;
  return {
    subscriberHash: itemString(item, 'subscriber_hash'),
    entitlements: itemJsonList(item, 'entitlements'),
    scope: itemString(item, 'scope'),
    clientId: itemString(item, 'client_id')
  };
}
