// 轻量级终端表格渲染器

export class Table {
  constructor({ columns }) {
    this.columns = columns;
    this.rows = [];
  }

  addRow(cells) {
    this.rows.push(cells);
  }

  render() {
    const colWidths = this.columns.map((col, i) => {
      const maxDataLen = Math.max(...this.rows.map(r => this._visualWidth(String(r[i] || ''))));
      return Math.max(this._visualWidth(col.title), maxDataLen, col.width || 10);
    });

    const sep = (l, m, r) => l + colWidths.map(w => '─'.repeat(w + 2)).join(m) + r;

    const lines = [];
    lines.push(sep('┌', '┬', '┐'));

    // Header
    lines.push('│ ' + this.columns.map((col, i) => this._pad(col.title, colWidths[i])).join(' │ ') + ' │');
    lines.push(sep('├', '┼', '┤'));

    // Rows
    for (const row of this.rows) {
      lines.push('│ ' + row.map((cell, i) => this._pad(String(cell || ''), colWidths[i])).join(' │ ') + ' │');
    }

    lines.push(sep('└', '┴', '┘'));
    return lines.join('\n');
  }

  _visualWidth(str) {
    let width = 0;
    for (const ch of str) {
      const code = ch.codePointAt(0);
      if (code >= 0x1100 && (
        code <= 0x115F ||
        code === 0x2329 || code === 0x232A ||
        (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F) ||
        (code >= 0xAC00 && code <= 0xD7A3) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0xFE10 && code <= 0xFE19) ||
        (code >= 0xFE30 && code <= 0xFE6F) ||
        (code >= 0xFF01 && code <= 0xFF60) ||
        (code >= 0xFFE0 && code <= 0xFFE6) ||
        (code >= 0x20000 && code <= 0x2FFFD) ||
        (code >= 0x30000 && code <= 0x3FFFD)
      )) {
        width += 2;
      } else {
        width += 1;
      }
    }
    return width;
  }

  _pad(str, width) {
    const visual = this._visualWidth(str);
    const pad = Math.max(0, width - visual);
    return str + ' '.repeat(pad);
  }
}
