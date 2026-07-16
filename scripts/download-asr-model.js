const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const rootDir = path.resolve(__dirname, "..");
const modelDir = path.resolve(rootDir, process.env.ASR_MODEL_DIR || "./models/sherpa-onnx-paraformer-zh-2024-03-09");

const files = [
  {
    name: "model.int8.onnx",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/model.int8.onnx?download=true"
  },
  {
    name: "tokens.txt",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/tokens.txt?download=true"
  },
  {
    name: "silero_vad.onnx",
    url: "https://huggingface.co/csukuangfj/vad/resolve/main/silero_vad.onnx?download=true"
  }
];

function maybeMirror(url) {
  if (process.env.HF_ENDPOINT) {
    return url.replace("https://huggingface.co", process.env.HF_ENDPOINT.replace(/\/$/, ""));
  }
  return url;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function renderProgress({ index, totalFiles, name, loaded, total, startedAt }) {
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speed = loaded / elapsedSeconds;
  const percent = total ? Math.floor((loaded / total) * 100) : 0;
  const size = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded);
  process.stdout.write(`\r[${index}/${totalFiles}] ${name} ${percent}% ${size} ${formatBytes(speed)}/s`);
}

async function download(file, index, totalFiles) {
  const target = path.join(modelDir, file.name);
  if (fs.existsSync(target)) {
    console.log(`[${index}/${totalFiles}] exists ${target}`);
    return;
  }

  const url = maybeMirror(file.url);
  console.log(`[${index}/${totalFiles}] download ${file.name}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed ${response.status} ${response.statusText}: ${url}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const startedAt = Date.now();
  let loaded = 0;

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(target);

    response.body.on("data", (chunk) => {
      loaded += chunk.length;
      renderProgress({ index, totalFiles, name: file.name, loaded, total, startedAt });
    });

    response.body.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    response.body.pipe(output);
  });

  process.stdout.write("\n");
  console.log(`[${index}/${totalFiles}] saved ${target}`);
}

async function main() {
  fs.mkdirSync(modelDir, { recursive: true });
  for (const [index, file] of files.entries()) {
    await download(file, index + 1, files.length);
  }
  console.log(`ASR model ready: ${modelDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
