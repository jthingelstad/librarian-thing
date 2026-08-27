import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { dynamodb } from './aws-clients.mjs';
import { errorFields, logEvent } from './logging.mjs';
import { renderDispatch } from './dispatch-generator.mjs';
import { getDispatchContentArtifact, putDispatchContentArtifact } from './dispatch-artifacts.mjs';
import { sendJmapEmail } from './jmap-mail.mjs';
import {
  claimReadyToSendDispatch,
  claimQueuedDispatch,
  dispatchFromItem,
  markDispatchFailed,
  markDispatchReadyToSend,
  markDispatchReadyToRetry,
  markDispatchSent
} from './dispatch-store.mjs';
import type { DispatchRecord } from './dispatch-store.mjs';
import type { DispatchSource } from './dispatch-generator.mjs';
import { fromDynamoAttr } from './user-conversations.mjs';

interface DispatchResult {
  subject: string;
  title: string;
  preview: string;
  text: string;
  html: string;
  model: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  sources: DispatchSource[];
  submission_id?: string;
}

interface DispatchRef {
  subscriberHash: string;
  dispatch: DispatchRecord;
}

export function isConditionalClaimConflict(error: unknown) {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error instanceof Error && error.name === 'ConditionalCheckFailedException')
  );
}

function subscriberHashFromUserPk(pk: unknown) {
  const text = String(pk || '');
  return text.startsWith('user#') ? text.slice('user#'.length) : '';
}

class DeliveryRetryScheduledError extends Error {
  retryScheduled = true;

  constructor(cause: unknown) {
    super(
      `Dispatch delivery preparation will retry: ${(cause instanceof Error ? cause.message : cause) || 'unknown error'}`,
      { cause }
    );
    this.name = 'DeliveryRetryScheduledError';
  }
}

class DeliveryFinalizedError extends Error {
  deliveryFinalized = true;

  constructor(cause: unknown) {
    super(
      `Dispatch delivery failed and was finalized: ${(cause instanceof Error ? cause.message : cause) || 'unknown error'}`,
      {
        cause
      }
    );
    this.name = 'DeliveryFinalizedError';
  }
}

function dispatchRefsFromStream(event: DynamoDBStreamEvent) {
  const refs: DispatchRef[] = [];
  const seen = new Set<string>();
  for (const record of event.Records || []) {
    const image = record.dynamodb?.NewImage || null;
    if (!image) continue;
    const sdkImage = image as unknown as Record<string, AttributeValue>;
    const itemType = String(fromDynamoAttr(sdkImage.item_type) || '');
    const status = String(fromDynamoAttr(sdkImage.status) || '');
    if (itemType !== 'dispatch' || !['queued', 'ready_to_send'].includes(status)) continue;
    const subscriberHash = subscriberHashFromUserPk(fromDynamoAttr(sdkImage.pk));
    const dispatch = dispatchFromItem(sdkImage);
    if (!subscriberHash || !dispatch.id || !dispatch.created_at) continue;
    const key = `${subscriberHash}\0${dispatch.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ subscriberHash, dispatch });
  }
  return refs;
}

async function resultFromDispatch(dispatch: DispatchRecord): Promise<DispatchResult> {
  const artifact =
    dispatch.content_artifact_bucket && dispatch.content_artifact_key
      ? await getDispatchContentArtifact({
          bucket: dispatch.content_artifact_bucket,
          key: dispatch.content_artifact_key
        })
      : {};
  return {
    subject: dispatch.subject,
    title: dispatch.title,
    preview: dispatch.preview,
    text: artifact.text || dispatch.content_text,
    html: artifact.html || dispatch.content_html,
    model: dispatch.model,
    usage: {
      inputTokens: dispatch.input_tokens || 0,
      outputTokens: dispatch.output_tokens || 0
    },
    sources: dispatch.sources as DispatchSource[]
  };
}

async function sendReadyDispatch({
  tableName,
  subscriberHash,
  dispatch
}: {
  tableName: string;
  subscriberHash: string;
  dispatch: DispatchRecord;
}) {
  const sending = await claimReadyToSendDispatch({
    dynamodb,
    tableName,
    subscriberHash,
    dispatch
  });
  let result;
  try {
    result = await resultFromDispatch(sending);
  } catch (error) {
    await markDispatchReadyToRetry({
      dynamodb,
      tableName,
      subscriberHash,
      dispatch: sending,
      error
    });
    throw new DeliveryRetryScheduledError(error);
  }
  let sent;
  try {
    sent = await sendJmapEmail({
      to: sending.to_email,
      subject: result.subject,
      text: result.text,
      html: result.html
    });
  } catch (error) {
    await markDispatchFailed({
      dynamodb,
      tableName,
      subscriberHash,
      dispatch: sending,
      error: `Dispatch delivery failed after a JMAP send attempt began. It was not retried to avoid sending a duplicate email. ${error instanceof Error ? error.message : error || ''}`
    });
    throw new DeliveryFinalizedError(error);
  }
  await markDispatchSent({
    dynamodb,
    tableName,
    subscriberHash,
    dispatch: sending,
    submissionId: sent.submission_id
  });
  return { dispatch: sending, result: { ...result, submission_id: sent.submission_id } };
}

export async function processDispatchStream({
  event = { Records: [] },
  tableName
}: {
  event?: DynamoDBStreamEvent;
  tableName: string;
}) {
  const refs = dispatchRefsFromStream(event);
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  for (const ref of refs) {
    let claimed;
    try {
      if (ref.dispatch.status === 'ready_to_send') {
        claimed = ref.dispatch;
      } else {
        claimed = await claimQueuedDispatch({
          dynamodb,
          tableName,
          subscriberHash: ref.subscriberHash,
          dispatch: ref.dispatch
        });
      }
    } catch (error) {
      if (isConditionalClaimConflict(error)) {
        skipped += 1;
        continue;
      }
      failed += 1;
      logEvent(
        'warning',
        'dispatch_claim_failed',
        errorFields(error, {
          subscriber_hash: ref.subscriberHash,
          dispatch_id: ref.dispatch.id
        })
      );
      continue;
    }

    try {
      let sentDispatch = claimed;
      let result;
      if (claimed.status === 'ready_to_send') {
        ({ dispatch: sentDispatch, result } = await sendReadyDispatch({
          tableName,
          subscriberHash: ref.subscriberHash,
          dispatch: claimed
        }));
      } else {
        const rendered = await renderDispatch(claimed);
        const artifact = await putDispatchContentArtifact({
          subscriberHash: ref.subscriberHash,
          dispatchId: claimed.id,
          result: rendered
        });
        const ready = await markDispatchReadyToSend({
          dynamodb,
          tableName,
          subscriberHash: ref.subscriberHash,
          dispatch: claimed,
          result: rendered,
          artifact
        });
        if (!ready) throw new Error('Dispatch could not be loaded after generation.');
        ({ dispatch: sentDispatch, result } = await sendReadyDispatch({
          tableName,
          subscriberHash: ref.subscriberHash,
          dispatch: ready
        }));
      }
      generated += 1;
      logEvent('info', 'dispatch_sent', {
        subscriber_hash: ref.subscriberHash,
        dispatch_id: sentDispatch.id,
        source_count: result.sources?.length || 0,
        output_tokens: result.usage?.outputTokens || 0
      });
    } catch (error) {
      // A ready-to-send record can be delivered by another stream invocation
      // before this invocation claims it. That is an idempotent skip, not a
      // delivery failure, and must not trigger a stale mark-failed attempt.
      if (isConditionalClaimConflict(error)) {
        skipped += 1;
        continue;
      }
      failed += 1;
      if (error instanceof DeliveryRetryScheduledError) {
        logEvent(
          'warning',
          'dispatch_delivery_retry_scheduled',
          errorFields(error.cause || error, {
            subscriber_hash: ref.subscriberHash,
            dispatch_id: claimed.id
          })
        );
        continue;
      }
      if (error instanceof DeliveryFinalizedError) {
        logEvent(
          'warning',
          'dispatch_delivery_failed',
          errorFields(error.cause || error, {
            subscriber_hash: ref.subscriberHash,
            dispatch_id: claimed.id
          })
        );
        continue;
      }
      await markDispatchFailed({
        dynamodb,
        tableName,
        subscriberHash: ref.subscriberHash,
        dispatch: claimed,
        error
      }).catch((markError) => {
        logEvent(
          'warning',
          'dispatch_mark_failed_failed',
          errorFields(markError, {
            subscriber_hash: ref.subscriberHash,
            dispatch_id: claimed.id
          })
        );
      });
      logEvent(
        'warning',
        claimed.status === 'ready_to_send' ? 'dispatch_delivery_failed' : 'dispatch_generation_failed',
        errorFields(error, {
          subscriber_hash: ref.subscriberHash,
          dispatch_id: claimed.id
        })
      );
    }
  }
  return {
    candidates: refs.length,
    generated,
    skipped,
    failed
  };
}
