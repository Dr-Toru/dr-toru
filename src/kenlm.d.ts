/**
 * Type declarations for the KenLM WASM module produced by
 * scripts/build-kenlm-wasm.sh via Emscripten with MODULARIZE=1.
 *
 * Usage in asr.worker.ts:
 *   const createKenLM = (await import("../public/kenlm/kenlm.js")).default;
 *   const mod: KenLMModule = await createKenLM();
 */

/** Pointer into WASM linear memory (returned by _malloc). */
type WasmPtr = number;

/** The Emscripten module instance with KenLM exports. */
export interface KenLMModule {
  // ---------- KenLM C exports ----------

  /** Load a model file from MEMFS. Returns 1 on success, 0 on failure. */
  _kenlm_load(pathPtr: WasmPtr): number;

  /** Byte size of a KenLM State struct. */
  _kenlm_state_size(): number;

  /** Write beginning-of-sentence state to |outPtr|. */
  _kenlm_bos_state(outPtr: WasmPtr): void;

  /** Write null-context state to |outPtr|. */
  _kenlm_null_state(outPtr: WasmPtr): void;

  /**
   * Score a word given the previous state.
   * Writes the new state to |outStatePtr|.
   * Returns log10 probability.
   */
  _kenlm_score_word(inStatePtr: WasmPtr, wordPtr: WasmPtr, outStatePtr: WasmPtr): number;

  /** Returns 1 if word is out-of-vocabulary, 0 otherwise. */
  _kenlm_is_oov(wordPtr: WasmPtr): number;

  /** Returns n-gram order of the loaded model. */
  _kenlm_order(): number;

  // ---------- Emscripten runtime ----------

  _malloc(size: number): WasmPtr;
  _free(ptr: WasmPtr): void;

  /** Raw WASM heap view. */
  HEAPU8: Uint8Array;

  /** Write a JS string to WASM memory as UTF-8. */
  stringToUTF8(str: string, outPtr: WasmPtr, maxBytesToWrite: number): void;

  /** Byte length of a JS string when encoded as UTF-8. */
  lengthBytesUTF8(str: string): number;

  /** Read a UTF-8 C string from WASM memory. */
  UTF8ToString(ptr: WasmPtr): string;

  /** Emscripten virtual filesystem. */
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    mkdir(path: string): void;
  };
}

/** Factory function exported by the Emscripten module (EXPORT_NAME=createKenLM). */
export type CreateKenLM = () => Promise<KenLMModule>;
