class TextChunker {
  constructor(options = {}) {
    this.minChars = options.minChars || 24;
    this.maxChars = options.maxChars || 48;
    this.minSentenceChars = options.minSentenceChars || 8;
    this.buffer = "";
    this.sentencePunctuation = new Set(["。", "！", "？", ".", "!", "?", "\n"]);
    this.pausePunctuation = new Set(["，", "；", ",", ";", "、", "：", ":"]);
  }

  push(text) {
    if (!text) return [];
    this.buffer += text;
    const chunks = [];

    while (this.buffer.length >= this.minSentenceChars) {
      let cut = -1;
      const limit = Math.min(this.buffer.length, this.maxChars);
      for (let i = 0; i < limit; i += 1) {
        if (this.sentencePunctuation.has(this.buffer[i]) && i + 1 >= this.minSentenceChars) {
          cut = i + 1;
          break;
        }
      }

      if (cut < 0 && this.buffer.length >= this.minChars) {
        for (let i = limit - 1; i >= this.minChars - 1; i -= 1) {
          if (this.pausePunctuation.has(this.buffer[i])) {
            cut = i + 1;
            break;
          }
        }
      }

      if (cut < 0 && this.buffer.length >= this.maxChars) {
        cut = limit;
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
