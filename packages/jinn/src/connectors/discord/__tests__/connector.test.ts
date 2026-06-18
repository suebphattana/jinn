import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "../../../shared/types.js";

const clients: any[] = [];
const mockSend = vi.fn().mockResolvedValue({ id: "msg1" });
const mockChannelsFetch = vi.fn();

vi.mock("discord.js", async (importActual) => {
  const actual = await importActual<any>();
  class MockClient {
    handlers: Record<string, any> = {};
    user = { id: "botid", tag: "bot#0001" };
    channels = { fetch: mockChannelsFetch };
    constructor() {
      clients.push(this);
    }
    on(evt: string, cb: any) {
      this.handlers[evt] = cb;
      return this;
    }
    once(evt: string, cb: any) {
      this.handlers[evt] = cb;
      return this;
    }
    login() {
      return Promise.resolve("ok");
    }
    destroy() {
      return Promise.resolve();
    }
  }
  return { ...actual, Client: MockClient };
});

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockTranscribe = vi.fn();
const mockGetModelPath = vi.fn();
vi.mock("../../../stt/stt.js", () => ({
  transcribe: (...a: any[]) => mockTranscribe(...a),
  getModelPath: (...a: any[]) => mockGetModelPath(...a),
  resolveLanguages: () => ["en"],
}));

vi.mock("../format.js", async (importActual) => {
  const actual = await importActual<any>();
  return { ...actual, downloadAttachment: vi.fn().mockResolvedValue("/tmp/voice.ogg") };
});

const { DiscordConnector } = await import("../index.js");

function lastClient(): any {
  return clients[clients.length - 1];
}

const textChannel = {
  isTextBased: () => true,
  isDMBased: () => false,
  isThread: () => false,
  name: "general",
  send: mockSend,
};

describe("DiscordConnector", () => {
  let connector: InstanceType<typeof DiscordConnector>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelsFetch.mockResolvedValue(textChannel);
    mockSend.mockResolvedValue({ id: "msg1" });
    connector = new DiscordConnector({ botToken: "x", id: "discord" });
  });

  it("advertises button capability", () => {
    expect(connector.getCapabilities().buttons).toBe(true);
  });

  describe("interactive buttons", () => {
    it("renders action-row buttons from a [buttons:…] directive", async () => {
      await connector.sendMessage({ channel: "chan1" }, "Pick [buttons: Yes | No]");
      expect(mockSend).toHaveBeenCalledTimes(1);
      const arg = mockSend.mock.calls[0][0];
      expect(arg.content).toBe("Pick");
      const row = arg.components[0].toJSON();
      expect(row.components.map((b: any) => b.label)).toEqual(["Yes", "No"]);
    });

    it("renders buttons from opts.buttons", async () => {
      await connector.sendMessage({ channel: "chan1" }, "Choose", {
        buttons: [["A", "B"], ["C"]],
      });
      const arg = mockSend.mock.calls[0][0];
      expect(arg.components).toHaveLength(2);
      expect(arg.components[1].toJSON().components[0].label).toBe("C");
    });

    it("feeds the tapped label back as an incoming message", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      await connector.sendMessage({ channel: "chan1" }, "[buttons: Approve | Reject]");
      const row = mockSend.mock.calls[0][0].components[0].toJSON();
      const approveId = row.components[0].custom_id;

      const rejectId = row.components[1].custom_id;
      const interactionCreate = lastClient().handlers.interactionCreate;
      expect(interactionCreate).toBeDefined();

      const update = vi.fn().mockResolvedValue(undefined);
      await interactionCreate({
        isButton: () => true,
        customId: approveId,
        guildId: "g1",
        channelId: "chan1",
        channel: textChannel,
        user: { id: "u1", username: "tapper" },
        message: {
          id: "m1",
          components: [
            {
              components: [
                { type: 2, style: 2, label: "Approve", custom_id: approveId },
                { type: 2, style: 2, label: "Reject", custom_id: rejectId },
              ],
            },
          ],
        },
        update,
      });

      // Pressed state: message updated with all buttons disabled, chosen one green.
      expect(update).toHaveBeenCalledOnce();
      const updated = update.mock.calls[0][0].components[0].toJSON();
      expect(updated.components.every((b: any) => b.disabled)).toBe(true);
      const approveBtn = updated.components.find((b: any) => b.custom_id === approveId);
      expect(approveBtn.style).toBe(3); // ButtonStyle.Success

      expect(handler).toHaveBeenCalledOnce();
      const msg: IncomingMessage = handler.mock.calls[0][0];
      expect(msg.text).toBe("Approve");
      expect(msg.channel).toBe("chan1");
      expect((msg.transportMeta as any).buttonTap).toBe(true);
    });

    it("ignores foreign button custom ids", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();
      const interactionCreate = lastClient().handlers.interactionCreate;
      await interactionCreate({
        isButton: () => true,
        customId: "someoneelse:1",
        guildId: "g1",
        channelId: "chan1",
        channel: textChannel,
        user: { id: "u1", username: "x" },
        message: { id: "m1" },
        deferUpdate: vi.fn(),
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("outbound file attachments", () => {
    it("attaches files to the message", async () => {
      await connector.sendMessage({ channel: "chan1" }, "Here", {
        files: ["/tmp/a.pdf"],
      });
      const arg = mockSend.mock.calls[0][0];
      expect(arg.content).toBe("Here");
      expect(arg.files).toEqual(["/tmp/a.pdf"]);
    });

    it("sends files with no text", async () => {
      await connector.sendMessage({ channel: "chan1" }, "", {
        files: ["/tmp/a.pdf"],
      });
      const arg = mockSend.mock.calls[0][0];
      expect(arg.files).toEqual(["/tmp/a.pdf"]);
    });
  });

  describe("voice transcription (inbound)", () => {
    function voiceMessage() {
      return {
        author: { bot: false, id: "u1", username: "user" },
        createdTimestamp: Date.now() + 10_000,
        guild: null,
        channel: {
          id: "chan1",
          isDMBased: () => false,
          isThread: () => false,
          isTextBased: () => true,
          name: "general",
        },
        content: "",
        id: "m1",
        attachments: new Map([
          [
            "a1",
            {
              url: "http://cdn/voice.ogg",
              name: "voice.ogg",
              contentType: "audio/ogg",
              flags: 1 << 13,
            },
          ],
        ]),
      };
    }

    it("transcribes a voice attachment and forwards the text", async () => {
      mockGetModelPath.mockReturnValue("/models/small.bin");
      mockTranscribe.mockResolvedValue("hello from voice");
      connector = new DiscordConnector({
        botToken: "x",
        id: "discord",
        stt: { enabled: true, model: "small" },
      });
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      await lastClient().handlers.messageCreate(voiceMessage());

      expect(mockTranscribe).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledOnce();
      expect((handler.mock.calls[0][0] as IncomingMessage).text).toBe("hello from voice");
    });

    it("drops the message with a warning when STT is disabled", async () => {
      // default connector has no stt config
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      await lastClient().handlers.messageCreate(voiceMessage());

      expect(handler).not.toHaveBeenCalled();
      // A warning was sent back to the channel
      const warned = mockSend.mock.calls.some((c) =>
        String(c[0]).includes("Couldn't transcribe"),
      );
      expect(warned).toBe(true);
    });
  });
});
