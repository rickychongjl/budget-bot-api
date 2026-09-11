import type {
  ChannelConnection,
  MessageSender,
  OutboundMessage,
  SendResult,
} from '../../src/core/shared/messaging';

/**
 * A scriptable `MessageSender`. M7 is Phase 4, so this is the only implementation of
 * the port in the repo — which is precisely why M5's tests assert on **how many times**
 * `send` was called, not just what it was called with: "one bundled message, not one
 * per category" is a delivery-count claim and nothing else can catch it regressing.
 */
export class FakeMessageSender implements MessageSender {
  readonly sent: { connection: ChannelConnection; message: OutboundMessage }[] = [];

  /** Results are consumed in order; once exhausted, every further send succeeds. */
  private readonly scripted: SendResult[];

  constructor(...scripted: SendResult[]) {
    this.scripted = [...scripted];
  }

  /** Queue further results. The harness hands the sender to the service on creation,
   *  so a test that wants a failure scripts it here rather than rebuilding the world. */
  script(...results: SendResult[]): this {
    this.scripted.push(...results);
    return this;
  }

  get callCount(): number {
    return this.sent.length;
  }

  /** The text of the only message sent — throws if that assumption does not hold. */
  get onlyText(): string {
    if (this.sent.length !== 1) {
      throw new Error(`expected exactly one message, got ${this.sent.length}`);
    }
    return this.sent[0]!.message.text;
  }

  async send(connection: ChannelConnection, message: OutboundMessage): Promise<SendResult> {
    this.sent.push({ connection, message });
    return this.scripted.shift() ?? { status: 'sent' };
  }
}
