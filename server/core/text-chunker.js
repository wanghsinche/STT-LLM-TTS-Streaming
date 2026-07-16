class TextChunker {
  constructor(options = {}) {
    this.minChars = options.minChars || 6;
    this.maxChars = options.maxChars || 16;
    this.buffer = "";
    this.punctuation = new Set(["，", "。", "！", "？", "；", ",", ".", "!", "?", ";", "\n"]);
  }

  push(text) {
    if (!text) return [];
    this.buffer += text;
    const chunks = [];

    while (this.buffer.length >= this.minChars) {
      let cut = -1;
      const limit = Math.min(this.buffer.length, this.maxChars);
      for (let i = 0; i < limit; i += 1) {
        if (this.punctuation.has(this.buffer[i])) {
          cut = i + 1;
          break;
        }
      }

      if (cut < 0 && this.buffer.length >= this.maxChars) {
        cut = this.maxChars;
      }

      if (cut < 0) break;

      const chunk = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (chunk) chunks.push(chunk);
    }

    return chunks;
  }

  flush() {
    const chunk = this.buffer.trim();
    this.buffer = "";
    return chunk ? [chunk] : [];
  }

  clear() {
    this.buffer = "";
  }
}

module.exports = { TextChunker };
