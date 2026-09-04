import { useEffect, useRef } from 'react';
import {
  deleteChatConversation,
  getChatConversation,
  listChatConversations,
  saveChatConversation,
} from '@neoting/contracts/client';
import { getChatConversationResponse, listChatConversationsResponse } from '@neoting/contracts/zod';
import type { ChatStoredMessage } from '@neoting/contracts/model';
import { useAppContext } from '../context/AppContext';
import { API_ENABLED } from './config';
import { unwrapBody } from './envelope';
import { fetchAllPages, PAGE_LIMIT } from './paged';
import type { Conversation, Message } from '../lib/types';

/**
 * Saved conversations (review item 9, 5 Sep 2026) — the wire half of "full
 * regular task and chat system". Until this, every conversation lived in React
 * state and a reload lost all of them.
 *
 * ## Where this module lives, and why that is load-bearing
 *
 * `useConversationSync` is mounted by `AIWorkspaceView` — a lazy route chunk —
 * and by NOTHING floor-resident. AppContext owns the conversation STATE and
 * exposes two hydration entry points; this module owns the WIRE. A fill effect
 * in AppContext would put the generated conversations client on the bundle
 * floor of every route (the S12 lesson, `apps/web/CLAUDE.md`), and chat is the
 * only route that ever needs it.
 *
 * ## The sync model: reconcile, debounced, client-driven
 *
 * `POST /chat/turns` stays side-effect-free — persistence is this CALLER's own
 * act. The hook watches the context's conversations and, 800 ms after they
 * settle, PUTs each changed one (whole conversation, replace-not-merge — the
 * contract's idempotency argument) and posts a deletion for each previously
 * known id that has disappeared. Text and intent name only: payloads, drafts
 * and display blocks are live-turn artefacts a transcript must not replay —
 * the staged proposal lives on in the Approvals queue, which is the point of
 * having one.
 *
 * Synthetic mode never mounts any of this (the hook gates on the session), so
 * METH_MODE §1's no-API walkthrough is byte-for-byte unchanged.
 */

const SAVE_DEBOUNCE_MS = 800;
/** The contract's cap; the caller trims from the front — the oldest lines matter least. */
const MAX_STORED_MESSAGES = 200;
const MAX_CONTENT = 4000;

/** Exported for its test — the boundary the transcript crosses on the way up. */
export function toStoredMessages(messages: readonly Message[], at: string): ChatStoredMessage[] {
  return messages.slice(-MAX_STORED_MESSAGES).map((message) => ({
    role: message.role,
    content: message.content.slice(0, MAX_CONTENT),
    ...(message.intent === undefined ? {} : { intent: message.intent.slice(0, 40) }),
    at,
  }));
}

/** Exported for its test — the boundary the transcript crosses on the way back down. */
export function fromStoredMessages(
  conversationId: string,
  stored: readonly { role: 'user' | 'assistant'; content: string; intent?: string | undefined }[],
): Message[] {
  return stored.map((entry, index) => ({
    id: `${conversationId}-restored-${index}`,
    role: entry.role,
    content: entry.content,
    // The stored name is one this app wrote; an unknown value falls through
    // IntentRenderer's `default` to a plain text bubble, which is the honest
    // rendering for a transcript whose payloads were deliberately not kept.
    ...(entry.intent === undefined ? {} : { intent: entry.intent as Message['intent'] }),
  }));
}

/** What a save must cover — anything here changing is what re-PUTs a conversation. Exported for its test. */
export function fingerprintOf(conversation: Conversation): string {
  return JSON.stringify({
    title: conversation.title,
    pinned: conversation.pinned,
    businessId: conversation.attachedClientIds[0] ?? null,
    messages: conversation.messages.map((m) => [m.role, m.content, m.intent ?? null]),
  });
}

/** A conversation worth persisting: it has a transcript, fetched or still remote. */
function isPersistable(conversation: Conversation): boolean {
  return conversation.messages.length > 0;
}

/**
 * Mounted once, by `AIWorkspaceView`. Hydrates the drawer from the server,
 * fetches the active conversation's transcript on demand, and reconciles
 * local changes (turns, pins, renames, deletions) back up.
 */
export function useConversationSync(): void {
  const { session, conversations, activeConversationId, hydrateConversations, hydrateConversationMessages } =
    useAppContext();
  const enabled = API_ENABLED && session.status === 'authenticated';

  // id → last fingerprint this browser saved (or 'remote' for a row known to
  // exist server-side whose transcript has not been fetched). Known ids that
  // vanish from the context are the deletions to reconcile.
  const known = useRef(new Map<string, string>());
  const hydrated = useRef(false);
  const loading = useRef(new Set<string>());

  // 1. Hydrate the drawer once per session.
  useEffect(() => {
    if (!enabled || hydrated.current) return;
    hydrated.current = true;
    void (async () => {
      try {
        const pages = await fetchAllPages((cursor) =>
          listChatConversations({ limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) }),
        );
        const summaries = [];
        for (const body of pages.bodies) {
          const parsed = listChatConversationsResponse.safeParse(unwrapBody(body));
          if (!parsed.success) return; // a contract drift must not corrupt the drawer
          summaries.push(...parsed.data.data);
        }
        for (const summary of summaries) known.current.set(summary.id, 'remote');
        hydrateConversations(summaries.map((s) => ({ ...s, businessId: s.businessId ?? null })));
      } catch {
        // The drawer degrades to session-local conversations; the next mount
        // retries. A failed history read must never block chatting.
        hydrated.current = false;
      }
    })();
  }, [enabled, hydrateConversations]);

  // 2. Fetch the active conversation's transcript when it is still a summary.
  const active = conversations.find((c) => c.id === activeConversationId);
  const needsLoad =
    enabled && active !== undefined && active.messages.length === 0 && (active.remoteMessageCount ?? 0) > 0;
  useEffect(() => {
    if (!needsLoad || active === undefined || loading.current.has(active.id)) return;
    loading.current.add(active.id);
    void (async () => {
      try {
        const body = unwrapBody(await getChatConversation(active.id));
        const parsed = getChatConversationResponse.safeParse(body);
        if (!parsed.success) return;
        const messages = fromStoredMessages(active.id, parsed.data.messages);
        // Record the restored state as already-saved BEFORE it lands in
        // context, so the reconciler below does not immediately PUT back the
        // bytes it just downloaded.
        known.current.set(
          active.id,
          fingerprintOf({ ...active, messages, remoteMessageCount: undefined }),
        );
        hydrateConversationMessages(active.id, messages);
      } finally {
        loading.current.delete(active.id);
      }
    })();
  }, [needsLoad, active, hydrateConversationMessages]);

  // 3. Reconcile local changes up, debounced.
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      void (async () => {
        const present = new Set<string>();
        for (const conversation of conversations) {
          present.add(conversation.id);
          // A hydrated summary whose transcript was never opened has nothing
          // local to save — and saving it would overwrite the server's copy
          // with an empty one.
          if ((conversation.remoteMessageCount ?? 0) > 0 && conversation.messages.length === 0) continue;
          if (!isPersistable(conversation)) continue;
          const fingerprint = fingerprintOf(conversation);
          if (known.current.get(conversation.id) === fingerprint) continue;
          try {
            await saveChatConversation(conversation.id, {
              title: conversation.title.slice(0, 120) || 'Conversation',
              businessId: conversation.attachedClientIds[0] ?? null,
              pinned: conversation.pinned,
              messages: toStoredMessages(conversation.messages, new Date().toISOString()),
            });
            known.current.set(conversation.id, fingerprint);
          } catch {
            // Left un-recorded so the next settle retries. A failed save must
            // never interrupt the conversation it is trying to keep.
          }
        }
        for (const id of [...known.current.keys()]) {
          if (present.has(id)) continue;
          try {
            await deleteChatConversation(id);
            known.current.delete(id);
          } catch {
            // Retried on the next settle for the same reason.
          }
        }
      })();
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, conversations]);
}
