const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

require("dotenv").config();

const { Client, Events, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const OpenAI = require("openai");
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
const WAKEWORD = process.env.WAKEWORD || "alexa";
const THRESHOLD = process.env.WAKEWORD_THRESHOLD || "0.5";
const DEBOUNCE = process.env.WAKEWORD_DEBOUNCE || "1.5";
const PYTHON = process.env.PYTHON || ".venv/bin/python";
const TOKEN = process.env.DISCORD_TOKEN;
const NAGA_API_KEY = process.env.NAGA_API_KEY;
const NAGA_BASE_URL = process.env.NAGA_BASE_URL || "https://api.naga.ac/v1";
const STT_MODEL = process.env.STT_MODEL || "whisper-large-v3:free";
const STT_LANGUAGE = process.env.STT_LANGUAGE || undefined;
const STT_PROMPT = process.env.STT_PROMPT || undefined;
const TRANSCRIBE_RECORDINGS = process.env.TRANSCRIBE_RECORDINGS !== "0";
const DEBUG_LOGS = process.env.DEBUG_LOGS === "1";
const LEVEL_LOG_INTERVAL_MS = Number(process.env.LEVEL_LOG_INTERVAL_MS || 1000);

if (!TOKEN) {
  console.error("Set DISCORD_TOKEN before starting the bot.");
  process.exit(1);
}

const sttClient = NAGA_API_KEY
  ? new OpenAI({
      apiKey: NAGA_API_KEY,
      baseURL: NAGA_BASE_URL,
    })
  : null;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function debug(message) {
  if (DEBUG_LOGS) log(message);
}

function warn(message) {
  console.warn(`[${new Date().toISOString()}] ${message}`);
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

    log(
      `Starting wakeword worker: ${PYTHON} ${args.join(" ")} ` +
        `(threshold=${THRESHOLD}, debounce=${DEBOUNCE}, debug=${DEBUG_LOGS ? "on" : "off"})`
    );

    this.child = spawn(PYTHON, args, {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.ready = false;
    this.dead = false;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.on("error", (error) => {
      this.dead = true;
      warn(`Wakeword worker failed to start: ${error.message}`);
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
    });
    this.child.on("exit", (code) => {
      this.dead = true;
      warn(`Wakeword worker exited with code ${code}`);
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

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        warn(`Wakeword worker sent non-JSON output: ${line}`);
        continue;
      }
      if (message.type === "ready") {
        this.ready = true;
        log(`Wakeword worker ready for ${message.wakeword} (threshold=${message.threshold})`);
        continue;
      }
      if (message.type === "error") {
        warn(`Wakeword worker error: ${message.message}`);
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
    if (this.dead || this.child.stdin.destroyed) {
      return Promise.reject(new Error("wakeword worker is not running"));
    }

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
    this.lastLevelLogAt = new Map();

    connection.receiver.speaking.on("start", (userId) => {
      debug(`Discord speaking start user=${userId}`);
      this.listenToUser(userId);
    });
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
    debug(`Subscribed to voice packets for user=${userId}`);
    opusStream.pipe(decoder);
    decoder.on("data", (pcm) => this.handlePcm(userId, pcm));
    decoder.once("end", () => {
      this.userStreams.delete(userId);
      debug(`Voice stream ended for user=${userId}`);
      if (this.activeUserId === userId) this.scheduleSilenceFinish();
    });
    decoder.once("error", (error) => {
      this.userStreams.delete(userId);
      warn(`Voice decoder error for user=${userId}: ${error.message}`);
      if (this.activeUserId === userId) this.scheduleSilenceFinish();
    });
  }

  async handlePcm(userId, pcm) {
    const now = Date.now();
    const mono16k = discordPcmToMono16k(pcm);
    const level = rms16(mono16k);
    this.logLevel(userId, level, pcm.length);

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
      let result;
      try {
        result = await this.worker.predict(userId, frame);
      } catch (error) {
        warn(`Wake prediction failed for user=${userId}: ${error.message}`);
        break;
      }

      if (DEBUG_LOGS || result.score >= 0.05 || result.detected) {
        log(
          `Wake score user=${userId} wakeword=${WAKEWORD} ` +
            `score=${Number(result.score).toFixed(4)} detected=${result.detected}`
        );
      }

      if (result.detected && !this.activeUserId) {
        await this.startRecording(userId);
        break;
      }
    }

    this.wakeBuffers.set(userId, wakeBuffer.subarray(offset));
  }

  logLevel(userId, level, pcmBytes) {
    if (!DEBUG_LOGS) return;

    const now = Date.now();
    const last = this.lastLevelLogAt.get(userId) || 0;
    if (now - last < LEVEL_LOG_INTERVAL_MS) return;

    this.lastLevelLogAt.set(userId, now);
    debug(
      `Voice level user=${userId} rms=${level.toFixed(1)} ` +
        `silenceRms=${SILENCE_RMS} pcmBytes=${pcmBytes} active=${this.activeUserId || "none"}`
    );
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
    log(`Wake detected. Recording user=${userId} name=${this.activeDisplayName}`);
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
    const durationMs = frames.reduce((sum, frame) => sum + frameDurationMs(frame.length), 0);
    this.activeUserId = null;
    this.activeDisplayName = "";
    this.recordingFrames = [];

    try {
      log(`Finishing recording user=${userName} reason=${reason} frames=${frames.length} durationMs=${Math.round(durationMs)}`);
      const mp3Path = await pcmFramesToMp3(frames);
      const transcript = await transcribeRecording(mp3Path);
      const content = [
        `Recording from ${userName} (${reason}).`,
        transcript ? `**Transcript:** ${transcript}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      await this.textChannel.send({
        content,
        files: [new AttachmentBuilder(mp3Path, { name: "wakeword-recording.mp3" })],
      });
      fs.rmSync(path.dirname(mp3Path), { recursive: true, force: true });
    } catch (error) {
      warn(`Recording processing failed: ${error.stack || error.message}`);
      await this.textChannel.send(`Recording finished, but processing failed: ${error.message}`);
    } finally {
      this.finishing = false;
    }
  }
}

async function transcribeRecording(mp3Path) {
  if (!TRANSCRIBE_RECORDINGS) return "";
  if (!sttClient) return "STT skipped: set NAGA_API_KEY in .env.";

  log(`Transcribing ${path.basename(mp3Path)} with ${STT_MODEL} at ${NAGA_BASE_URL}`);
  const transcription = await sttClient.audio.transcriptions.create({
    model: STT_MODEL,
    file: fs.createReadStream(mp3Path),
    language: STT_LANGUAGE,
    prompt: STT_PROMPT,
  });

  log(`Transcription done, chars=${transcription.text?.length || 0}`);
  return transcription.text?.trim() || "";
}

async function pcmFramesToMp3(frames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeword-discordjs-"));
  const rawPath = path.join(dir, "recording.pcm");
  const mp3Path = path.join(dir, "recording.mp3");
  fs.writeFileSync(rawPath, Buffer.concat(frames));
  log(`Encoding MP3 from ${frames.length} PCM frames`);

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
  log(`MP3 encoded: ${mp3Path}`);
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
  log(`Logged in as ${readyClient.user.tag}`);
  log(
    `Config wakeword=${WAKEWORD} threshold=${THRESHOLD} silenceMs=${SILENCE_MS} ` +
      `silenceRms=${SILENCE_RMS} transcribe=${TRANSCRIBE_RECORDINGS ? "on" : "off"} ` +
      `sttModel=${STT_MODEL} debug=${DEBUG_LOGS ? "on" : "off"}`
  );
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
    log(`Joined voice channel guild=${voiceChannel.guild.id} channel=${voiceChannel.id}`);

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
    log(`Left voice channel guild=${message.guild.id}`);
    await message.reply("Stopped listening.");
  }
});

client.login(TOKEN);
