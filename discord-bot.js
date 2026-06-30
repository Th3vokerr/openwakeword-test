const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

require("dotenv").config();

const { Client, Events, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const {
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const prism = require("prism-media");
const ffmpegStatic = require("ffmpeg-static");

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const WAKEWORD_FRAME_SAMPLES = 1280;
const PCM_WIDTH_BYTES = 2;
const PRE_ROLL_MS = Number(process.env.PRE_ROLL_MS || 1000);
const SILENCE_MS = Number(process.env.SILENCE_MS || 1100);
const SILENCE_RMS = Number(process.env.SILENCE_RMS || 450);
const MAX_RECORDING_MS = Number(process.env.MAX_RECORDING_MS || 30000);
const PREFIX = process.env.BOT_PREFIX || "!";
const WAKEWORD = process.env.WAKEWORD || "hey_jarvis";
const THRESHOLD = process.env.WAKEWORD_THRESHOLD || "0.5";
const DEBOUNCE = process.env.WAKEWORD_DEBOUNCE || "1.5";
const PYTHON = process.env.PYTHON || ".venv/bin/python";
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error("Set DISCORD_TOKEN before starting the bot.");
  process.exit(1);
}

function rms16(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function discordPcmToMono16k(pcm) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const mono = new Int16Array(Math.floor(samples.length / DISCORD_CHANNELS / 3));
  let out = 0;
  for (let i = 0; i + 5 < samples.length; i += 6) {
    mono[out++] = Math.round((samples[i] + samples[i + 1]) / 2);
  }
  return mono;
}

function int16ToBuffer(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function frameDurationMs(pcmBytes) {
  return (pcmBytes / (DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * PCM_WIDTH_BYTES)) * 1000;
}

class WakewordWorker {
  constructor() {
    const args = [
      "wakeword_worker.py",
      "--wakeword",
      WAKEWORD,
      "--threshold",
      THRESHOLD,
      "--debounce",
      DEBOUNCE,
    ];
    if (process.env.DOWNLOAD_MODELS === "1") args.push("--download-models");

    this.child = spawn(PYTHON, args, {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`wakeword worker exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      const message = JSON.parse(line);
      if (message.type === "ready") {
        console.log(`Wakeword worker ready for ${message.wakeword}`);
        continue;
      }
      if (message.type === "error") {
        console.error(`Wakeword worker error: ${message.message}`);
        continue;
      }

      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  predict(userId, audioFrame) {
    const id = this.nextId++;
    const payload = {
      id,
      userId,
      audio: audioFrame.toString("base64"),
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
}

class GuildRecorder {
  constructor(connection, textChannel, worker) {
    this.connection = connection;
    this.textChannel = textChannel;
    this.worker = worker;
    this.userStreams = new Map();
    this.preRoll = new Map();
    this.wakeBuffers = new Map();
    this.activeUserId = null;
    this.activeDisplayName = "";
    this.recordingFrames = [];
    this.lastVoiceAt = 0;
    this.startedAt = 0;
    this.finishing = false;
    this.silenceTimer = null;
    this.maxTimer = null;

    connection.receiver.speaking.on("start", (userId) => this.listenToUser(userId));
  }

  listenToUser(userId) {
    if (this.userStreams.has(userId)) return;

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterInactivity, duration: 250 },
    });
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: DISCORD_CHANNELS,
      rate: DISCORD_SAMPLE_RATE,
    });

    this.userStreams.set(userId, decoder);
    opusStream.pipe(decoder);
    decoder.on("data", (pcm) => this.handlePcm(userId, pcm));
    decoder.once("end", () => {
      this.userStreams.delete(userId);
      if (this.activeUserId === userId) this.scheduleSilenceFinish();
    });
    decoder.once("error", () => {
      this.userStreams.delete(userId);
      if (this.activeUserId === userId) this.scheduleSilenceFinish();
    });
  }

  async handlePcm(userId, pcm) {
    const now = Date.now();
    const mono16k = discordPcmToMono16k(pcm);
    const level = rms16(mono16k);

    if (this.activeUserId) {
      if (userId !== this.activeUserId) return;

      this.recordingFrames.push(Buffer.from(pcm));
      if (level >= SILENCE_RMS) this.lastVoiceAt = now;
      this.scheduleSilenceFinish();

      if (!this.finishing && now - this.lastVoiceAt >= SILENCE_MS) await this.finish("silence");
      return;
    }

    this.pushPreRoll(userId, pcm);
    if (level < SILENCE_RMS) return;

    const wakeBuffer = Buffer.concat([
      this.wakeBuffers.get(userId) || Buffer.alloc(0),
      int16ToBuffer(mono16k),
    ]);
    const frameBytes = WAKEWORD_FRAME_SAMPLES * PCM_WIDTH_BYTES;
    let offset = 0;

    while (!this.activeUserId && wakeBuffer.length - offset >= frameBytes) {
      const frame = wakeBuffer.subarray(offset, offset + frameBytes);
      offset += frameBytes;
      const result = await this.worker.predict(userId, frame);
      if (result.detected && !this.activeUserId) {
        await this.startRecording(userId);
        break;
      }
    }

    this.wakeBuffers.set(userId, wakeBuffer.subarray(offset));
  }

  pushPreRoll(userId, pcm) {
    const frames = this.preRoll.get(userId) || [];
    frames.push(Buffer.from(pcm));
    let totalMs = frames.reduce((sum, frame) => sum + frameDurationMs(frame.length), 0);
    while (frames.length && totalMs > PRE_ROLL_MS) {
      totalMs -= frameDurationMs(frames.shift().length);
    }
    this.preRoll.set(userId, frames);
  }

  async startRecording(userId) {
    const user = await client.users.fetch(userId).catch(() => null);
    this.activeUserId = userId;
    this.activeDisplayName = user?.username || userId;
    this.recordingFrames = [...(this.preRoll.get(userId) || [])];
    this.lastVoiceAt = Date.now();
    this.startedAt = Date.now();
    this.wakeBuffers.clear();
    this.scheduleSilenceFinish();
    this.maxTimer = setTimeout(() => void this.finish("max length"), MAX_RECORDING_MS);
    await this.textChannel.send(`Wake word detected from <@${userId}>. Recording until they stop talking...`);
  }

  scheduleSilenceFinish() {
    if (!this.activeUserId) return;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);

    const remainingMs = Math.max(0, SILENCE_MS - (Date.now() - this.lastVoiceAt));
    this.silenceTimer = setTimeout(() => void this.finish("silence"), remainingMs);
  }

  async finish(reason) {
    if (this.finishing || !this.activeUserId) return;
    this.finishing = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.silenceTimer = null;
    this.maxTimer = null;

    const userName = this.activeDisplayName;
    const frames = this.recordingFrames;
    this.activeUserId = null;
    this.activeDisplayName = "";
    this.recordingFrames = [];

    try {
      const mp3Path = await pcmFramesToMp3(frames);
      await this.textChannel.send({
        content: `Recording from ${userName} (${reason}).`,
        files: [new AttachmentBuilder(mp3Path, { name: "wakeword-recording.mp3" })],
      });
      fs.rmSync(path.dirname(mp3Path), { recursive: true, force: true });
    } catch (error) {
      await this.textChannel.send(`Recording finished, but MP3 encoding failed: ${error.message}`);
    } finally {
      this.finishing = false;
    }
  }
}

async function pcmFramesToMp3(frames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeword-discordjs-"));
  const rawPath = path.join(dir, "recording.pcm");
  const mp3Path = path.join(dir, "recording.mp3");
  fs.writeFileSync(rawPath, Buffer.concat(frames));

  const ffmpeg = ffmpegStatic || "ffmpeg";
  const child = spawn(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "s16le",
    "-ar",
    String(DISCORD_SAMPLE_RATE),
    "-ac",
    String(DISCORD_CHANNELS),
    "-i",
    rawPath,
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "4",
    mp3Path,
  ]);

  const [code] = await once(child, "exit");
  if (code !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`ffmpeg exited with code ${code}`);
  }
  fs.rmSync(rawPath, { force: true });
  return mp3Path;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});
const worker = new WakewordWorker();
const recorders = new Map();

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const [command] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  if (command === "join") {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      await message.reply("Join a voice channel first.");
      return;
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const recorder = new GuildRecorder(connection, message.channel, worker);
    recorders.set(message.guild.id, recorder);
    await message.reply(`Listening for \`${WAKEWORD}\`. After it triggers, I lock onto that user and send an MP3.`);
  }

  if (command === "leave") {
    const connection = getVoiceConnection(message.guild.id);
    if (!connection) {
      await message.reply("I'm not connected to a voice channel.");
      return;
    }
    connection.destroy();
    recorders.delete(message.guild.id);
    await message.reply("Stopped listening.");
  }
});

client.login(TOKEN);
