const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const scoreText = document.querySelector("#score");
const stateText = document.querySelector("#state");
const wakewordText = document.querySelector("#wakeword");
const meter = document.querySelector("#meter");
const log = document.querySelector("#log");

let audioContext;
let micStream;
let sourceNode;
let workletNode;
let socket;

const appendLog = (message) => {
  const time = new Date().toLocaleTimeString();
  log.textContent = `[${time}] ${message}\n${log.textContent}`.slice(0, 4000);
};

const setRunning = (running) => {
  startButton.disabled = running;
  stopButton.disabled = !running;
  stateText.textContent = running ? "listening" : "idle";
};

const connectSocket = () =>
  new Promise((resolve, reject) => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${location.host}/ws/audio`);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "ready") {
        wakewordText.textContent = data.wakeword;
        appendLog(`ready: ${data.wakeword}, threshold ${data.threshold}`);
        return;
      }

      if (data.type === "prediction") {
        scoreText.textContent = data.score.toFixed(3);
        meter.value = data.score;

        if (data.detected) {
          stateText.textContent = "wake word detected";
          appendLog(`detected ${data.wakeword} (${data.score.toFixed(3)})`);
          setTimeout(() => {
            if (!startButton.disabled) return;
            stateText.textContent = "listening";
          }, 900);
        }
      }
    });
  });

const start = async () => {
  setRunning(true);
  appendLog("requesting microphone");

  await connectSocket();

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("/static/pcm-worklet.js");

  sourceNode = audioContext.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-16k-worklet", {
    processorOptions: {
      inputSampleRate: audioContext.sampleRate,
      outputSampleRate: 16000,
      frameSamples: 1280,
    },
  });

  workletNode.port.onmessage = (event) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(event.data);
    }
  };

  sourceNode.connect(workletNode);
  appendLog(`mic streaming at ${audioContext.sampleRate} Hz, sending 16 kHz PCM`);
};

const stop = async () => {
  workletNode?.disconnect();
  sourceNode?.disconnect();
  micStream?.getTracks().forEach((track) => track.stop());
  socket?.close();

  if (audioContext && audioContext.state !== "closed") {
    await audioContext.close();
  }

  audioContext = undefined;
  micStream = undefined;
  sourceNode = undefined;
  workletNode = undefined;
  socket = undefined;
  meter.value = 0;
  setRunning(false);
  appendLog("stopped");
};

startButton.addEventListener("click", () => {
  start().catch((error) => {
    setRunning(false);
    appendLog(`error: ${error.message}`);
  });
});

stopButton.addEventListener("click", () => {
  stop().catch((error) => appendLog(`stop error: ${error.message}`));
});
