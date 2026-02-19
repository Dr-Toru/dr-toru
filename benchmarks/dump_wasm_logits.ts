import * as ort from "onnxruntime-web";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODEL = "/tmp/medasr_fp32_single.onnx";
const rows = 6448;
const cols = 128;

// Load features as raw f32
const featureBuf = fs.readFileSync("/tmp/hf_features_f32.bin");
const f32 = new Float32Array(
  featureBuf.buffer,
  featureBuf.byteOffset,
  rows * cols,
);
console.log(
  `Features: ${rows}x${cols}, first 3: ${f32[0]}, ${f32[1]}, ${f32[2]}`,
);

ort.env.wasm.numThreads = 1;
const modelData = fs.readFileSync(MODEL);
const session = await ort.InferenceSession.create(modelData.buffer, {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});

const inputTensor = new ort.Tensor("float32", f32, [1, rows, cols]);
const maskTensor = new ort.Tensor("bool", new Uint8Array(rows).fill(1), [
  1,
  rows,
]);
const outputs = await session.run({
  input_features: inputTensor,
  attention_mask: maskTensor,
});
const logits = outputs.logits;
const logitData = logits.data as Float32Array;
const frames = logits.dims[1];
const vocabSize = logits.dims[2];
console.log(`WASM logits: ${frames}x${vocabSize}`);

// Save as raw f32
fs.writeFileSync(
  "/tmp/ort_wasm_logits.bin",
  Buffer.from(logitData.buffer, logitData.byteOffset, logitData.byteLength),
);
console.log("Saved WASM logits");

// Quick CTC decode
const vocab = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "public/models/medasr_lasr_vocab.json"),
    "utf-8",
  ),
);
const tokens: string[] = vocab.tokens;
const result: string[] = [];
let prev = -1;
for (let t = 0; t < frames; t++) {
  let best = 0;
  let bestVal = logitData[t * vocabSize];
  for (let v = 1; v < vocabSize; v++) {
    if (logitData[t * vocabSize + v] > bestVal) {
      bestVal = logitData[t * vocabSize + v];
      best = v;
    }
  }
  if (best !== 0 && best !== prev && best !== 2 && best < tokens.length)
    result.push(tokens[best]);
  prev = best;
}
console.log(`\n[WASM CTC]\n${result.join("").replace(/▁/g, " ").trim()}`);
