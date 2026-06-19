import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, Target } from "../../../shared/types.js";

// Mock node-telegram-bot-api before importing connector
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockEditMessageText = vi.fn().mockResolvedValue(true);
const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockStartPolling = vi.fn();
const mockStopPolling = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();
const mockSendDocument = vi.fn().mockResolvedValue({ message_id: 7 });
const mockAnswerCallbackQuery = vi.fn().mockResolvedValue(true);
const mockSendChatAction = vi.fn().mockResolvedValue(true);
const mockEditMessageReplyMarkup = vi.fn().mockResolvedValue(true);
const mockSetMyCommands = vi.fn().mockResolvedValue(true);

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = mockSendMessage;
    this.editMessageText = mockEditMessageText;
    this.getMe = mockGetMe;
    this.startPolling = mockStartPolling;
    this.stopPolling = mockStopPolling;
    this.on = mockOn;
    this.sendDocument = mockSendDocument;
    this.answerCallbackQuery = mockAnswerCallbackQuery;
    this.sendChatAction = mockSendChatAction;
    this.editMessageReplyMarkup = mockEditMessageReplyMarkup;
    this.setMyCommands = mockSetMyCommands;
  });
  return { default: MockBot };
});

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
const { TelegramConnector } = await import("../index.js");

describe("TelegramConnector", () => {
  let connector: InstanceType<typeof TelegramConnector>;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new TelegramConnector({
      botToken: "123456:ABC-DEF",
    });
  });

  describe("constructor", () => {
    it("sets the connector name to telegram", () => {
      expect(connector.name).toBe("telegram");
    });
  });

  describe("getCapabilities", () => {
    it("returns correct capabilities", () => {
      expect(connector.getCapabilities()).toEqual({
        threading: false,
        messageEdits: true,
        reactions: false,
        attachments: true,
        buttons: true,
      });
    });
  });

  describe("getHealth", () => {
    it("returns stopped before start", () => {
      const health = connector.getHealth();
      expect(health.status).toBe("stopped");
    });
  });

  describe("start", () => {
    it("registers message handler and starts polling after validation", async () => {
      await connector.start();
      const health = connector.getHealth();
      expect(health.status).toBe("running");
      expect(mockGetMe).toHaveBeenCalledOnce();
      expect(mockStartPolling).toHaveBeenCalledOnce();
      expect(mockOn).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("registers the slash command menu via setMyCommands", async () => {
      await connector.start();
      expect(mockSetMyCommands).toHaveBeenCalledOnce();
      const cmds = mockSetMyCommands.mock.calls[0][0].map((c: any) => c.command);
      expect(cmds).toEqual(expect.arrayContaining(["reset", "goal", "compact"]));
    });

    it("does not start polling if getMe fails (invalid token)", async () => {
      mockGetMe.mockRejectedValueOnce(new Error("Invalid token"));
      await connector.start();
      const health = connector.getHealth();
      expect(health.status).toBe("error");
      expect(health.detail).toContain("Invalid token");
      expect(mockStartPolling).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("stops polling and sets stopped state", async () => {
      await connector.start();
      await connector.stop();
      expect(mockStopPolling).toHaveBeenCalledOnce();
      expect(connector.getHealth().status).toBe("stopped");
    });
  });

  describe("onMessage", () => {
    it("routes incoming messages to the handler", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      // Get the registered message callback
      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      expect(messageCallback).toBeDefined();

      // Simulate incoming Telegram message
      const telegramMsg = {
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "testuser", first_name: "Test", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello bot!",
      };
      await messageCallback(telegramMsg);

      expect(handler).toHaveBeenCalledOnce();
      const msg: IncomingMessage = handler.mock.calls[0][0];
      expect(msg.connector).toBe("telegram");
      expect(msg.source).toBe("telegram");
      expect(msg.sessionKey).toBe("telegram:12345");
      expect(msg.text).toBe("Hello bot!");
      expect(msg.user).toBe("testuser");
      expect(msg.userId).toBe("67890");
      expect(msg.channel).toBe("12345");
    });

    it("ignores messages from bots", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      const botMsg = {
        message_id: 1,
        chat: { id: 12345, type: "private" as const },
        from: { id: 999, username: "test_bot", first_name: "Bot", is_bot: true },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Bot message",
      };
      await messageCallback(botMsg);

      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores messages from unauthorized users when allowFrom is set", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      // Unauthorized user
      const msg = {
        message_id: 1,
        chat: { id: 11111, type: "private" as const },
        from: { id: 99999, username: "stranger", first_name: "Stranger", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello",
      };
      await messageCallback(msg);
      expect(handler).not.toHaveBeenCalled();
    });

    it("rejects messages with from: undefined when allowFrom is set", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      // Channel post or forwarded message with no `from`
      const msg = {
        message_id: 1,
        chat: { id: 11111, type: "channel" as const },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Channel post",
      };
      await messageCallback(msg);
      expect(handler).not.toHaveBeenCalled();
    });

    it("allows messages from authorized users through allowFrom", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      const msg = {
        message_id: 1,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "allowed_user", first_name: "Allowed", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello",
      };
      await messageCallback(msg);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("sendMessage", () => {
    it("sends a message to the target chat", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "Hello!");
      expect(mockSendMessage).toHaveBeenCalledWith("12345", "Hello!", {
        parse_mode: "Markdown",
      });
    });

    it("does not send empty messages", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("chunks long messages", async () => {
      const target: Target = { channel: "12345" };
      const longText = "A".repeat(5000);
      await connector.sendMessage(target, longText);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it("retries without parse_mode on Markdown parse error", async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce({ message_id: 2 });
      const target: Target = { channel: "12345" };
      const result = await connector.sendMessage(target, "**bad markdown");
      // First call with Markdown, second without
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage.mock.calls[0][2]).toEqual({ parse_mode: "Markdown" });
      expect(mockSendMessage.mock.calls[1][2]).toEqual({});
      expect(result).toBe("2");
    });
  });

  describe("replyMessage", () => {
    it("sends a reply to a specific message", async () => {
      const target: Target = {
        channel: "12345",
        replyContext: { chatId: 12345, messageId: 42 },
      };
      await connector.replyMessage(target, "Reply!");
      expect(mockSendMessage).toHaveBeenCalledWith("12345", "Reply!", {
        parse_mode: "Markdown",
        reply_to_message_id: 42,
      });
    });
  });

  describe("editMessage", () => {
    it("edits an existing message", async () => {
      const target: Target = {
        channel: "12345",
        messageTs: "42",
      };
      await connector.editMessage(target, "Edited!");
      expect(mockEditMessageText).toHaveBeenCalledWith("Edited!", {
        chat_id: "12345",
        message_id: 42,
        parse_mode: "Markdown",
      });
    });
  });

  describe("interactive buttons", () => {
    it("renders an inline keyboard from a [buttons:…] directive", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "Pick one [buttons: Yes | No]");
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text, opts] = mockSendMessage.mock.calls[0];
      expect(chatId).toBe("12345");
      expect(text).toBe("Pick one");
      const kb = (opts as any).reply_markup.inline_keyboard;
      expect(kb).toHaveLength(1);
      expect(kb[0].map((b: any) => b.text)).toEqual(["Yes", "No"]);
      expect(kb[0].every((b: any) => typeof b.callback_data === "string")).toBe(true);
    });

    it("renders an inline keyboard from opts.buttons", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "Choose", {
        buttons: [["A", "B"], ["C"]],
      });
      const kb = (mockSendMessage.mock.calls[0][2] as any).reply_markup.inline_keyboard;
      expect(kb).toHaveLength(2);
      expect(kb[1][0].text).toBe("C");
    });

    it("sends a minimal carrier message when buttons but no text", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "[buttons: Go]");
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const [, text, opts] = mockSendMessage.mock.calls[0];
      expect(text).toBe("👇");
      expect((opts as any).reply_markup.inline_keyboard[0][0].text).toBe("Go");
    });

    it("feeds the tapped label back as an incoming message", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      // Render buttons to register a callback_data → label mapping.
      await connector.sendMessage({ channel: "555" }, "[buttons: Approve | Reject]");
      const kb = (mockSendMessage.mock.calls.at(-1)![2] as any).reply_markup.inline_keyboard;
      const approveData = kb[0][0].callback_data;

      const cbCallback = mockOn.mock.calls.find((c) => c[0] === "callback_query")?.[1];
      expect(cbCallback).toBeDefined();

      await cbCallback({
        id: "cbq1",
        data: approveData,
        from: { id: 67890, username: "tapper", first_name: "Tap" },
        message: { message_id: 100, chat: { id: 555, type: "private" } },
      });

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("cbq1");
      // Pressed state: keyboard collapsed to the chosen label with a check.
      expect(mockEditMessageReplyMarkup).toHaveBeenCalled();
      const newMarkup = mockEditMessageReplyMarkup.mock.calls[0][0];
      expect(newMarkup.inline_keyboard[0][0].text).toBe("✓ Approve");
      expect(handler).toHaveBeenCalledOnce();
      const msg: IncomingMessage = handler.mock.calls[0][0];
      expect(msg.text).toBe("Approve");
      expect(msg.channel).toBe("555");
      expect((msg.transportMeta as any).buttonTap).toBe(true);
    });

    it("ignores foreign / expired callback data but still answers it", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();
      const cbCallback = mockOn.mock.calls.find((c) => c[0] === "callback_query")?.[1];
      await cbCallback({
        id: "cbq2",
        data: "not-ours:99",
        from: { id: 67890, username: "x" },
        message: { message_id: 1, chat: { id: 1, type: "private" } },
      });
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith("cbq2");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("outbound file attachments", () => {
    it("sends files via sendDocument", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "Here you go", {
        files: ["/tmp/report.pdf"],
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1); // the caption text
      expect(mockSendDocument).toHaveBeenCalledWith("12345", "/tmp/report.pdf", {});
    });

    it("sends multiple files", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "", {
        files: ["/tmp/a.png", "/tmp/b.png"],
      });
      expect(mockSendDocument).toHaveBeenCalledTimes(2);
    });

    it("attaches the keyboard to the last file when there is no text", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "", {
        files: ["/tmp/a.png"],
        buttons: [["OK"]],
      });
      const opts = mockSendDocument.mock.calls[0][2] as any;
      expect(opts.reply_markup.inline_keyboard[0][0].text).toBe("OK");
    });
  });

  describe("reconstructTarget", () => {
    it("reconstructs target from reply context", () => {
      const target = connector.reconstructTarget({
        chatId: 12345,
        messageId: 42,
      });
      expect(target.channel).toBe("12345");
      expect(target.messageTs).toBe("42");
      expect(target.replyContext).toEqual({ chatId: 12345, messageId: 42 });
    });
  });
});
