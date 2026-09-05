/**
 * view_photo: fetch archive photos so the MCP surface can return them as
 * image content blocks — the photo renders inline in the client AND the
 * calling model gets vision over it, instead of a URL it can only talk
 * about. (Clients deliberately never hot-link image URLs out of text; an
 * image block in the tool result is the sanctioned path.)
 *
 * Hosts are allowlisted to the archive's real photo homes — the same set
 * the Thingy web app renders inline (markdown-config.ts) — because the
 * URL argument is caller-controlled and this Lambda must not become an
 * open image proxy.
 *
 * No server-side resize (sharp is a platform binary this Lambda doesn't
 * carry): most archive photos are already CDN-rehosted at 1200px and a
 * few hundred KB. A per-call byte budget keeps the tool result inside
 * transport and vision-cost sanity; an oversized original is refused by
 * name with its URL still usable as a link. Resizing is the upgrade path
 * if refusals turn out to be common.
 */

export const VIEW_PHOTO_MAX_IMAGES = 3;
export const VIEW_PHOTO_MAX_IMAGE_BYTES = 1_000_000;
export const VIEW_PHOTO_BYTE_BUDGET = 1_500_000;

// Parity with the web app's inline-image allowlist (thingy web,
// markdown-config.ts). thingelstad.com and subdomains, plus the external
// hosts the archive's photos actually live on.
const IMAGE_HOSTS = new Set([
  'cdn.uploads.micro.blog',
  'assets.buttondown.email',
  'buttondown-attachments.s3.us-west-2.amazonaws.com'
]);

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function allowedImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host === 'thingelstad.com' || host.endsWith('.thingelstad.com') || IMAGE_HOSTS.has(host)) {
      return url.href;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

export interface FetchedPhoto {
  url: string;
  mimeType: string;
  dataBase64: string;
  bytes: number;
}

export interface RefusedPhoto {
  url: string;
  reason: string;
}

export interface PhotoViewResult {
  photos: FetchedPhoto[];
  refused: RefusedPhoto[];
}

export async function fetchPhotos(urls: unknown): Promise<PhotoViewResult> {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u ?? '').trim()).filter(Boolean);
  const photos: FetchedPhoto[] = [];
  const refused: RefusedPhoto[] = [];
  let budget = VIEW_PHOTO_BYTE_BUDGET;

  for (const [index, raw] of list.entries()) {
    if (index >= VIEW_PHOTO_MAX_IMAGES) {
      refused.push({ url: raw, reason: `over the ${VIEW_PHOTO_MAX_IMAGES}-image limit for one call` });
      continue;
    }
    const url = allowedImageUrl(raw);
    if (!url) {
      refused.push({ url: raw, reason: 'not an archive image host' });
      continue;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
      if (!res.ok) {
        refused.push({ url, reason: `fetch failed (${res.status})` });
        continue;
      }
      const mimeType = String(res.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!IMAGE_MIME_TYPES.has(mimeType)) {
        refused.push({ url, reason: `not an image (${mimeType || 'unknown type'})` });
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > VIEW_PHOTO_MAX_IMAGE_BYTES || buffer.length > budget) {
        refused.push({
          url,
          reason: 'too large for inline viewing — link to it instead'
        });
        continue;
      }
      budget -= buffer.length;
      photos.push({ url, mimeType, dataBase64: buffer.toString('base64'), bytes: buffer.length });
    } catch {
      refused.push({ url, reason: 'fetch failed' });
    }
  }

  return { photos, refused };
}
