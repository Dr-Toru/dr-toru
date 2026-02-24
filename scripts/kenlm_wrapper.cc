/**
 * KenLM WASM wrapper — exposes n-gram language model scoring for use in
 * the ASR web worker via Emscripten.
 *
 * Compiled with:  scripts/build-kenlm-wasm.sh
 * Output:         plugin-bundles/medasr/kenlm/kenlm.{js,wasm}
 *
 * API (extern "C"):
 *   kenlm_load(path)             → 1 on success, 0 on failure
 *   kenlm_state_size()           → byte size of a State struct
 *   kenlm_bos_state(out)         → write beginning-of-sentence state
 *   kenlm_null_state(out)        → write null context state
 *   kenlm_score_word(in, word, out) → log10 probability
 *   kenlm_is_oov(word)           → 1 if word is out-of-vocabulary
 *   kenlm_order()                → n-gram order of loaded model
 */

#include "lm/model.hh"
#include <cstring>
#include <memory>

// Use the type-erased Model base which auto-detects the binary format
// (probing, trie, quantized trie, etc.) at load time.
static std::unique_ptr<lm::base::Model> g_model;

extern "C" {

int kenlm_load(const char* path) {
    try {
        lm::ngram::Config config;
        config.load_method = util::POPULATE_OR_READ;
        g_model.reset(lm::ngram::LoadVirtual(path, config));
        return 1;
    } catch (...) {
        g_model.reset();
        return 0;
    }
}

int kenlm_state_size() {
    if (!g_model) return 0;
    return static_cast<int>(g_model->StateSize());
}

void kenlm_bos_state(void* out) {
    if (!g_model) return;
    g_model->BeginSentenceWrite(out);
}

void kenlm_null_state(void* out) {
    if (!g_model) return;
    g_model->NullContextWrite(out);
}

/**
 * Score a single word given the previous state.
 * Writes the new state into |out_state|.
 * Returns the log10 probability of the word.
 */
float kenlm_score_word(const void* in_state, const char* word, void* out_state) {
    if (!g_model) return -100.0f;

    const auto& vocab = g_model->BaseVocabulary();
    lm::WordIndex wid = vocab.Index(word);

    return g_model->BaseScore(in_state, wid, out_state);
}

int kenlm_is_oov(const char* word) {
    if (!g_model) return 1;
    const auto& vocab = g_model->BaseVocabulary();
    return vocab.Index(word) == vocab.NotFound() ? 1 : 0;
}

int kenlm_order() {
    if (!g_model) return 0;
    return static_cast<int>(g_model->Order());
}

} // extern "C"
