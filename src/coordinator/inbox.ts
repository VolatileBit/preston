import type { InboundMessage } from "../channels/types.js";
import { type Clock, isoNow } from "../clock.js";
import { all, type Db, one, run } from "../store/db.js";

export interface StoredMessage {
  id: number;
  message: InboundMessage;
  /** How many Coordinator turns have started on it (more than one means it was replayed). */
  attempts: number;
}

interface Row {
  id: number;
  channel: InboundMessage["channel"];
  ref: string;
  conversation_id: string;
  sender_id: string;
  text: string;
  received_at: string;
  attempts: number;
}

/**
 * Owner messages for the Coordinator, persisted before they are processed and marked handled
 * only in the same write that records the reply. A crash, a restart or an out-of-quota
 * Coordinator therefore never loses a message; it is answered later, once.
 */
export class Inbox {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Stores a message. Returns its ID, or undefined when the Channel delivered it before. */
  record(message: InboundMessage): number | undefined {
    const changes = run(
      this.db,
      `INSERT OR IGNORE INTO inbound_messages (channel, ref, conversation_id, sender_id, text, received_at, state)
       VALUES (:channel, :ref, :conversation, :sender, :text, :received, 'pending')`,
      {
        channel: message.channel,
        ref: message.ref,
        conversation: message.conversationId,
        sender: message.senderId,
        text: message.text,
        received: message.receivedAt || isoNow(this.clock),
      },
    );
    if (changes === 0) return undefined;
    return one<{ id: number }>(
      this.db,
      "SELECT id FROM inbound_messages WHERE channel = :channel AND ref = :ref",
      { channel: message.channel, ref: message.ref },
    )?.id;
  }

  get(id: number): StoredMessage | undefined {
    const row = one<Row & { state: string }>(
      this.db,
      "SELECT * FROM inbound_messages WHERE id = :id AND state = 'pending'",
      { id },
    );
    return row ? toStored(row) : undefined;
  }

  /** Unhandled messages, oldest first. */
  pending(): StoredMessage[] {
    return all<Row>(
      this.db,
      "SELECT * FROM inbound_messages WHERE state = 'pending' ORDER BY id",
    ).map(toStored);
  }

  started(id: number): void {
    run(this.db, "UPDATE inbound_messages SET attempts = attempts + 1 WHERE id = :id", { id });
  }

  /** Call inside the transaction that records the reply. */
  handled(id: number): void {
    run(this.db, "UPDATE inbound_messages SET state = 'handled', handled_at = :at WHERE id = :id", {
      id,
      at: isoNow(this.clock),
    });
  }
}

function toStored(row: Row): StoredMessage {
  return {
    id: row.id,
    attempts: row.attempts,
    message: {
      channel: row.channel,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      isOwner: true,
      text: row.text,
      ref: row.ref,
      receivedAt: row.received_at,
    },
  };
}
