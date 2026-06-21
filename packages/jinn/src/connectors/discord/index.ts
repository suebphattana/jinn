import {
  Client,
  Status,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ApplicationCommandDataResolvable,
  type MessageCreateOptions,
} from "discord.js";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  Target,
  SendOptions,
} from "../../shared/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../../shared/logger.js";
import { TMP_DIR } from "../../shared/paths.js";
import { formatResponse, downloadAttachment } from "./format.js";
import { deriveSessionKey, buildReplyContext, isOldMessage } from "./threads.js";
import { parseButtons, ButtonRegistry, type ButtonRow } from "../shared/buttons.js";
import {
  transcribe as sttTranscribe,
  resolveLanguages,
  getModelPath,
} from "../../stt/stt.js";

/** Native slash commands registered with Discord so they show in the "/" picker.
 *  Each maps to the same text command the session manager already handles. */
const SLASH_COMMANDS: ApplicationCommandDataResolvable[] = [
  { name: "new", description: "Start a fresh session (clears the conversation)" },
  { name: "reset", description: "Reset the session and clear any goal" },
  { name: "compact", description: "Compact the conversation to reduce context" },
  { name: "status", description: "Show current session status" },
  { name: "doctor", description: "Check engine and connector health" },
  {
    name: "goal",
    description: "Set / show / clear an ongoing goal",
    options: [
      {
        name: "text",
        description: "Goal text (empty to view, 'clear' to remove)",
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: "model",
    description: "Change this session's model",
    options: [
      { name: "name", description: "Model name, e.g. opus / sonnet", type: 3, required: true },
    ],
  },
  {
    name: "effort",
    description: "Set the reasoning-effort level for this session",
    options: [
      {
        name: "level",
        description: "Effort level (empty to view / pick from buttons)",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
          { name: "xhigh", value: "xhigh" },
        ],
      },
    ],
  },
];

export interface DiscordSttConfig {
  enabled?: boolean;
  model?: string;
  language?: string;
  languages?: string[];
}

export interface DiscordConnectorConfig {
  /** Unique instance identifier (e.g. "discord-vox") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken?: string;
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  guildId?: string;
  /** Only respond to messages in this channel (right-click channel → Copy Channel ID) */
  channelId?: string;
  /** Route messages from specific channels to remote Jinn instances */
  channelRouting?: Record<string, string>;
  /** If set, this instance proxies all Discord operations through the primary instance at this URL */
  proxyVia?: string;
  /** Speech-to-text settings forwarded from top-level `config.stt` */
  stt?: DiscordSttConfig;
}

/** How often the watchdog checks the gateway connection. */
const WATCHDOG_INTERVAL_MS = 60_000;
/** If the WebSocket stays not-ready longer than this, force a reconnect. */
const RECOVER_AFTER_MS = 120_000;

export class DiscordConnector implements Connector {
  name: string;
  instanceId: string;
  private client: Client;
  private config: DiscordConnectorConfig;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private bootTimeMs = Date.now();
  private allowedUserIds: Set<string>;
  private status: "starting" | "running" | "stopped" | "error" = "starting";
  private lastError: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private buttons = new ButtonRegistry();
  private sttChain: Promise<unknown> = Promise.resolve();
  // Connection watchdog — recovers a silently-wedged gateway link (the bot goes
  // deaf with no error event, /api/status still "running"). See start()/recover().
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private notReadySince: number | null = null;
  private recovering = false;

  constructor(config: DiscordConnectorConfig) {
    this.name = config.id || "discord";
    this.instanceId = config.id || "discord";
    this.config = config;
    // Normalize Discord IDs to strings (YAML may parse large snowflake IDs as numbers)
    if (this.config.guildId) this.config.guildId = String(this.config.guildId);
    if (this.config.channelId) this.config.channelId = String(this.config.channelId);
    if (this.config.channelRouting) {
      this.config.channelRouting = Object.fromEntries(
        Object.entries(this.config.channelRouting).map(([k, v]) => [String(k), v])
      );
    }
    this.allowedUserIds = new Set(
      Array.isArray(config.allowFrom)
        ? config.allowFrom
        : config.allowFrom
        ? [config.allowFrom]
        : [],
    );
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  getEmployee(): string | undefined {
    return this.config.employee;
  }

  async start(): Promise<void> {
    this.client.on("ready", () => {
      logger.info(`Discord connector ready as ${this.client.user?.tag}`);
      this.status = "running";
      this.lastError = null;
      this.notReadySince = null;
      // Register native slash commands so they appear in Discord's "/" picker.
      void this.registerSlashCommands();
    });

    // --- Connection lifecycle: observe shard health and recover from drops. ---
    // discord.js auto-reconnects most drops, but a shard can stay down (exhausted
    // retries) or the session can be `invalidated` (it gives up entirely). Without
    // handling these the bot goes silently deaf while /api/status still says
    // "running" — the exact "ไม่ขึ้นอะไรเลย" wedge. Log them and let the watchdog
    // force a reconnect if the link stays down.
    this.client.on("shardDisconnect", (event, shardId) => {
      logger.warn(`Discord shard ${shardId} disconnected (code ${event?.code ?? "?"})`);
    });
    this.client.on("shardReconnecting", (shardId) => {
      logger.info(`Discord shard ${shardId} reconnecting…`);
    });
    this.client.on("shardResume", (shardId) => {
      logger.info(`Discord shard ${shardId} resumed`);
      this.status = "running";
      this.notReadySince = null;
    });
    this.client.on("shardError", (err, shardId) => {
      logger.warn(`Discord shard ${shardId} error: ${err.message}`);
    });
    this.client.on("invalidated", () => {
      logger.error("Discord session invalidated — forcing reconnect");
      void this.recover("session invalidated");
    });

    this.client.on("messageCreate", async (message) => {
      try {
        await this.handleMessage(message);
      } catch (err) {
        logger.error(`Discord message handler error: ${err instanceof Error ? err.message : err}`);
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isButton()) {
          await this.handleButtonInteraction(interaction);
        } else if (interaction.isChatInputCommand()) {
          await this.handleSlashCommand(interaction);
        }
      } catch (err) {
        logger.error(`Discord interaction handler error: ${err instanceof Error ? err.message : err}`);
      }
    });

    this.client.on("error", (err) => {
      this.lastError = err.message;
      this.status = "error";
      logger.error(`Discord client error: ${err.message}`);
    });

    await this.client.login(this.config.botToken);
    this.startWatchdog();
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.client.destroy();
    logger.info("Discord connector stopped");
  }

  /** Periodically verify the gateway link is live. A drop discord.js can't
   *  auto-recover (exhausted retries / invalidated / silent zombie) otherwise
   *  leaves the bot deaf with no event. If the WebSocket stays not-ready past
   *  RECOVER_AFTER_MS, force a destroy+relogin. */
  private startWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.status === "stopped" || this.recovering) return;
      if (this.client.ws.status === Status.Ready) {
        this.notReadySince = null;
        return;
      }
      const now = Date.now();
      if (this.notReadySince == null) {
        this.notReadySince = now;
        logger.warn(`Discord link not ready (ws status=${this.client.ws.status}); watching`);
        return;
      }
      if (now - this.notReadySince >= RECOVER_AFTER_MS) {
        void this.recover(`ws not ready for ${Math.round((now - this.notReadySince) / 1000)}s`);
      }
    }, WATCHDOG_INTERVAL_MS);
    // Don't keep the process alive solely for the watchdog.
    this.watchdog.unref?.();
  }

  /** Force a clean reconnect (destroy + re-login). Idempotent while in flight. */
  private async recover(reason: string): Promise<void> {
    if (this.recovering || this.status === "stopped") return;
    this.recovering = true;
    logger.warn(`Discord connector recovering: ${reason}`);
    try {
      try { await this.client.destroy(); } catch { /* already down */ }
      await this.client.login(this.config.botToken);
      logger.info("Discord connector reconnected");
      this.lastError = null;
      this.notReadySince = null;
    } catch (err) {
      this.status = "error";
      this.lastError = `recovery failed: ${err instanceof Error ? err.message : err}`;
      logger.error(`Discord connector recovery failed: ${this.lastError}`);
    } finally {
      this.recovering = false;
    }
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      threading: true,
      messageEdits: true,
      reactions: true,
      attachments: true,
      buttons: true,
    };
  }

  getHealth(): ConnectorHealth {
    // Report the LIVE WebSocket state, not a sticky field — a silently-dropped
    // gateway link must surface as "error" so health checks/watchdog can see it
    // (previously this stayed "running" while the bot was deaf).
    let status: ConnectorHealth["status"];
    let detail = this.lastError ?? undefined;
    const notReadyMs = this.notReadySince == null ? 0 : Date.now() - this.notReadySince;
    if (this.status === "stopped") {
      status = "stopped";
    } else if (this.status === "error") {
      status = "error";
    } else if (this.client.ws.status === Status.Ready) {
      status = "running";
    } else if (this.recovering) {
      status = "error";
      detail = detail ?? "reconnecting";
    } else if (notReadyMs >= WATCHDOG_INTERVAL_MS) {
      // Sustained not-ready (the watchdog has been tracking it) — real wedge.
      status = "error";
      detail = detail ?? `gateway not ready for ${Math.round(notReadyMs / 1000)}s (ws status=${this.client.ws.status})`;
    } else {
      // Boot handshake or a brief reconnect blip — optimistic, not yet a wedge.
      status = "running";
    }
    return { status, detail, capabilities: this.getCapabilities() };
  }

  reconstructTarget(replyContext: Record<string, unknown> | null | undefined): Target {
    const ctx = (replyContext ?? {}) as Record<string, string | null>;
    return {
      channel: ctx.channel ?? "",
      thread: ctx.thread ?? undefined,
      messageTs: ctx.messageTs ?? undefined,
    };
  }

  async sendMessage(target: Target, text: string, opts?: SendOptions): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(target.channel);
      if (!channel || !channel.isTextBased()) return;
      return await this.sendChunks(channel as TextChannel | DMChannel | ThreadChannel, text, opts);
    } catch (err) {
      logger.error(`Discord sendMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async replyMessage(target: Target, text: string, opts?: SendOptions): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      return await this.sendChunks(channel as TextChannel | DMChannel | ThreadChannel, text, opts);
    } catch (err) {
      logger.error(`Discord replyMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Send text in Discord-sized chunks, attaching any files and interactive
   *  buttons to the final message. Buttons come from an explicit opts.buttons
   *  or from a `[buttons:…]` directive embedded in the text. */
  private async sendChunks(
    channel: TextChannel | DMChannel | ThreadChannel,
    text: string,
    opts?: SendOptions,
  ): Promise<string | undefined> {
    const parsed = parseButtons(text);
    const rows = opts?.buttons ?? parsed.rows ?? undefined;
    const components = rows ? this.buildComponents(rows) : undefined;
    const chunks = formatResponse(parsed.cleanedText);
    const files = opts?.files ?? [];

    // Nothing but attachments/buttons (no text content)
    if (chunks.length === 0) {
      if (files.length === 0 && !components) return undefined;
      const payload: MessageCreateOptions = {};
      if (files.length > 0) payload.files = files;
      if (components) payload.components = components;
      const sent = await channel.send(payload);
      return sent.id;
    }

    let lastId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      let payload: string | MessageCreateOptions = chunks[i];
      if (isLast && (files.length > 0 || components)) {
        const obj: MessageCreateOptions = { content: chunks[i] };
        if (files.length > 0) obj.files = files;
        if (components) obj.components = components;
        payload = obj;
      }
      const sent = await channel.send(payload);
      lastId = sent.id;
    }
    return lastId;
  }

  /** Build Discord action rows of buttons from label rows, registering each
   *  label so the tap callback can recover it. */
  private buildComponents(
    rows: ButtonRow[],
  ): ActionRowBuilder<ButtonBuilder>[] {
    return rows.map((row) => {
      const builder = new ActionRowBuilder<ButtonBuilder>();
      for (const label of row) {
        builder.addComponents(
          new ButtonBuilder()
            .setCustomId(this.buttons.register(label))
            .setLabel(label.slice(0, 80))
            .setStyle(ButtonStyle.Secondary),
        );
      }
      return builder;
    });
  }

  async editMessage(target: Target, text: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      // Edits are single-message: keep only the first chunk (same boundary
      // logic as sends, truncated to the platform limit).
      const [chunk] = formatResponse(text);
      await msg.edit(chunk);
    } catch (err) {
      logger.error(`Discord editMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async addReaction(target: Target, emoji: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      await msg.react(emoji);
    } catch {
      // non-fatal
    }
  }

  async removeReaction(target: Target, emoji: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      await msg.reactions.cache.get(emoji)?.users.remove(this.client.user?.id);
    } catch {
      // non-fatal
    }
  }

  async setTypingStatus(channelId: string, _threadTs: string | undefined, status: string): Promise<void> {
    const existing = this.typingIntervals.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(channelId);
    }
    if (!status) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).sendTyping();
        // Discord typing expires after 10s — refresh every 8s
        const interval = setInterval(async () => {
          try {
            await (channel as TextChannel).sendTyping();
          } catch { /* non-fatal */ }
        }, 8_000);
        this.typingIntervals.set(channelId, interval);
      }
    } catch {
      // non-fatal
    }
  }

  /** Register native slash commands per-guild (instant) so they appear in the
   *  Discord "/" picker. Re-run on every ready; set() overwrites idempotently. */
  private async registerSlashCommands(): Promise<void> {
    try {
      const app = this.client.application;
      if (!app) return;
      const guilds = [...this.client.guilds.cache.keys()];
      if (guilds.length === 0) {
        await app.commands.set(SLASH_COMMANDS);
        logger.info("Discord: registered global slash commands");
        return;
      }
      for (const guildId of guilds) {
        await app.commands.set(SLASH_COMMANDS, guildId);
      }
      logger.info(`Discord: registered slash commands in ${guilds.length} guild(s)`);
    } catch (err) {
      logger.warn(`Discord: slash command registration failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Handle a native slash command: ack ephemerally, then feed the equivalent
   *  text command into the session pipeline (reusing all existing handlers). */
  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    // Gating mirrors inbound messages.
    if (this.config.guildId && interaction.guildId !== this.config.guildId) return;
    if (
      this.config.channelId &&
      interaction.channelId !== this.config.channelId &&
      !interaction.channel?.isDMBased()
    ) return;
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(interaction.user.id)) return;
    if (!this.handler) return;

    const name = interaction.commandName;
    const arg =
      interaction.options.getString("text") ??
      interaction.options.getString("name") ??
      interaction.options.getString("level") ??
      interaction.options.getString("args") ??
      "";
    const text = arg ? `/${name} ${arg}` : `/${name}`;

    // Ack within Discord's 3s window; the real result posts as a channel message.
    try {
      await interaction.reply({ content: `⚙️ \`${text}\``, ephemeral: true });
    } catch {
      /* non-fatal */
    }

    const ch = interaction.channel;
    const isDM = ch?.isDMBased() ?? false;
    const isThread = ch?.isThread() ?? false;
    const sessionKey = isDM
      ? `${this.instanceId}:dm:${interaction.user.id}`
      : isThread
      ? `${this.instanceId}:thread:${interaction.channelId}`
      : `${this.instanceId}:${interaction.channelId}`;

    this.handler({
      connector: this.instanceId,
      source: "discord",
      sessionKey,
      channel: interaction.channelId ?? "",
      thread: isThread ? interaction.channelId ?? undefined : undefined,
      user: interaction.user.username,
      userId: interaction.user.id,
      text,
      attachments: [],
      replyContext: {
        channel: interaction.channelId ?? "",
        thread: isThread ? interaction.channelId ?? null : null,
        messageTs: null,
        guildId: interaction.guildId ?? null,
      },
      raw: interaction,
      transportMeta: {
        channelName:
          ch && ch.isTextBased() && "name" in ch ? (ch as TextChannel).name : "dm",
        guildId: interaction.guildId ?? null,
        isDM,
        slashCommand: true,
      },
    });
  }

  /** Rebuild a button message's action rows with every button disabled, and the
   *  tapped button recoloured green — the "pressed" state Discord lacks natively. */
  private disableComponents(
    interaction: ButtonInteraction,
  ): ActionRowBuilder<ButtonBuilder>[] {
    const rows = (interaction.message?.components ?? []) as Array<{ components: any[] }>;
    return rows.map((row) => {
      const newRow = new ActionRowBuilder<ButtonBuilder>();
      for (const comp of row.components) {
        const cid = comp.customId ?? comp.custom_id;
        // Link buttons (style 5) have no custom_id and can't be recoloured.
        const isLink = (comp.style ?? comp.data?.style) === ButtonStyle.Link;
        const btn = ButtonBuilder.from(comp).setDisabled(true);
        if (!isLink && cid && cid === interaction.customId) {
          btn.setStyle(ButtonStyle.Success);
        }
        newRow.addComponents(btn);
      }
      return newRow;
    });
  }

  /** Handle a button tap: recover the label and feed it back into the session
   *  as a normal incoming message, so the running turn continues naturally. */
  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const label = this.buttons.resolve(interaction.customId);
    if (label === null) return; // not one of ours (or expired)

    // Same gating as inbound messages.
    if (this.config.guildId && interaction.guildId !== this.config.guildId) return;
    if (
      this.config.channelId &&
      interaction.channelId !== this.config.channelId &&
      !interaction.channel?.isDMBased()
    ) return;
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(interaction.user.id)) return;
    if (!this.handler) return;

    // Acknowledge AND show a pressed state: disable every button on the
    // message and recolour the tapped one green, so the choice is visible and
    // can't be tapped twice. Falls back to a bare ack if the edit fails.
    try {
      await interaction.update({ components: this.disableComponents(interaction) });
    } catch {
      try {
        await interaction.deferUpdate();
      } catch {
        /* non-fatal */
      }
    }

    const ch = interaction.channel;
    const isDM = ch?.isDMBased() ?? false;
    const isThread = ch?.isThread() ?? false;
    const sessionKey = isDM
      ? `${this.instanceId}:dm:${interaction.user.id}`
      : isThread
      ? `${this.instanceId}:thread:${interaction.channelId}`
      : `${this.instanceId}:${interaction.channelId}`;

    const incomingMessage: IncomingMessage = {
      connector: this.instanceId,
      source: "discord",
      sessionKey,
      channel: interaction.channelId ?? "",
      thread: isThread ? interaction.channelId ?? undefined : undefined,
      user: interaction.user.username,
      userId: interaction.user.id,
      text: label,
      attachments: [],
      replyContext: {
        channel: interaction.channelId ?? "",
        thread: isThread ? interaction.channelId ?? null : null,
        messageTs: interaction.message?.id ?? null,
        guildId: interaction.guildId ?? null,
      },
      messageId: interaction.message?.id,
      raw: interaction,
      transportMeta: {
        channelName:
          ch && ch.isTextBased() && "name" in ch ? (ch as TextChannel).name : "dm",
        guildId: interaction.guildId ?? null,
        isDM,
        buttonTap: true,
      },
    };

    this.handler(incomingMessage);
  }

  /** Detect a Discord voice message: the IS_VOICE_MESSAGE attachment flag
   *  (bit 13) or an audio/* content type. */
  private isVoiceAttachment(att: {
    flags?: number | { bitfield?: number } | null;
    contentType?: string | null;
  }): boolean {
    const flags = att.flags;
    const bits = typeof flags === "number" ? flags : flags?.bitfield ?? 0;
    if (bits & (1 << 13)) return true;
    return Boolean(att.contentType?.startsWith("audio/"));
  }

  /** Download a voice attachment and transcribe it via the STT module.
   *  Returns null (and logs) when STT is unavailable or transcription fails.
   *  Transcriptions are serialized to avoid parallel whisper runs OOMing. */
  private async transcribeVoice(att: {
    url: string;
    name?: string | null;
  }): Promise<string | null> {
    const model = this.config.stt?.model || "small";
    let unavailable: string | null = null;
    if (!this.config.stt?.enabled) {
      unavailable = "voice transcription is not enabled on this gateway";
    } else if (!getModelPath(model)) {
      unavailable = `STT model '${model}' is not downloaded`;
    }
    if (unavailable) {
      logger.warn(`Discord: dropping voice message — ${unavailable}`);
      return null;
    }

    const langs = resolveLanguages(this.config.stt);
    const language = langs.length === 1 ? langs[0] : "auto";

    const myTurn = this.sttChain.then(async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-stt-"));
      try {
        const localPath = await downloadAttachment(att.url, tmpDir, att.name || "voice.ogg");
        return await sttTranscribe(localPath, model, language);
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* non-fatal */
        }
      }
    });
    this.sttChain = myTurn.catch(() => undefined);

    try {
      return await myTurn;
    } catch (err) {
      logger.error(`Discord STT failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bots (including self)
    if (message.author.bot) return;
    logger.debug(`Discord message from ${message.author.username} in channel ${message.channel.id}`);

    // Ignore old messages on boot
    if (
      this.config.ignoreOldMessagesOnBoot !== false &&
      isOldMessage(message.createdTimestamp, this.bootTimeMs)
    ) return;

    // Guild restriction
    if (this.config.guildId && message.guild?.id !== this.config.guildId) return;

    // Channel routing — proxy messages to remote instances
    const routeTarget = this.config.channelRouting?.[message.channel.id];
    if (routeTarget) {
      logger.debug(`Routing Discord message from channel ${message.channel.id} to ${routeTarget}`);
      await this.proxyToRemote(routeTarget, message);
      return;
    }

    // Channel restriction — only respond in a specific channel (+ DMs always allowed)
    if (this.config.channelId && message.channel.id !== this.config.channelId && !message.channel.isDMBased()) return;

    // User allowlist
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(message.author.id)) return;

    if (!this.handler) return;

    const sessionKey = deriveSessionKey(message, this.instanceId);
    const replyContext = buildReplyContext(message);

    // Separate voice messages (transcribed via STT) from regular attachments
    // (downloaded and forwarded to the engine).
    const allAtts = Array.from(message.attachments.values());
    const voiceAtts = allAtts.filter((a) => this.isVoiceAttachment(a));
    const fileAtts = allAtts.filter((a) => !this.isVoiceAttachment(a));

    const attachments = await Promise.all(
      fileAtts.map(async (att) => {
        try {
          const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
          return { name: att.name, localPath, mimeType: att.contentType ?? "application/octet-stream" };
        } catch {
          return null;
        }
      }),
    ).then((results) => results.filter(Boolean) as Array<{ name: string; localPath: string; mimeType: string }>);

    let messageText = message.content;
    if (voiceAtts.length > 0) {
      const transcript = await this.transcribeVoice(voiceAtts[0]);
      if (transcript) {
        messageText = messageText ? `${messageText}\n\n${transcript}` : transcript;
      } else if (!messageText && attachments.length === 0) {
        // Nothing usable came through — tell the user rather than forwarding empty text.
        try {
          const channel = await this.client.channels.fetch(message.channel.id);
          if (channel?.isTextBased()) {
            await (channel as TextChannel | DMChannel | ThreadChannel).send(
              "⚠️ Couldn't transcribe your voice message. Please try again or type instead.",
            );
          }
        } catch {
          /* non-fatal */
        }
        return;
      }
    }

    const incomingMessage: IncomingMessage = {
      connector: this.instanceId,
      source: "discord",
      sessionKey,
      channel: message.channel.id,
      thread: message.channel.isThread() ? message.channel.id : undefined,
      user: message.author.username,
      userId: message.author.id,
      text: messageText,
      attachments: attachments.map((a) => ({
        name: a.name,
        url: "",
        mimeType: a.mimeType,
        localPath: a.localPath,
      })),
      replyContext,
      messageId: message.id,
      raw: message,
      transportMeta: {
        channelName: message.channel.isTextBased() && "name" in message.channel
          ? (message.channel as TextChannel).name
          : "dm",
        guildId: message.guild?.id ?? null,
        isDM: message.channel.isDMBased(),
      },
    };

    this.handler(incomingMessage);
  }

  /** Forward a message to a remote Jinn instance via HTTP */
  private async proxyToRemote(remoteUrl: string, message: Message): Promise<void> {
    try {
      const attachments = Array.from(message.attachments.values()).map((att) => ({
        name: att.name,
        url: att.url,
        mimeType: att.contentType ?? "application/octet-stream",
      }));

      const payload = {
        sessionKey: deriveSessionKey(message),
        channel: message.channel.id,
        thread: message.channel.isThread() ? message.channel.id : undefined,
        user: message.author.username,
        userId: message.author.id,
        text: message.content,
        messageId: message.id,
        attachments,
        replyContext: buildReplyContext(message),
        transportMeta: {
          channelName: message.channel.isTextBased() && "name" in message.channel
            ? (message.channel as TextChannel).name
            : "dm",
          guildId: message.guild?.id ?? null,
          isDM: message.channel.isDMBased(),
        },
      };

      const res = await fetch(`${remoteUrl.replace(/\/+$/, "")}/api/connectors/discord/incoming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        logger.error(`Failed to proxy Discord message to ${remoteUrl}: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      logger.error(`Discord proxy error to ${remoteUrl}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
