const inlinePattern = /(\x60[^\x60\n]+\x60|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;
const fenceStart = /^ {0,3}(\x60{3,}|~{3,})\s*([\w+.-]*)[^\n]*$/;
const headingStart = /^ {0,3}(#{1,6})[ \t]+(.+)$/;
const listStart = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/;
const quoteStart = /^ {0,3}> ?(.*)$/;
const divider = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
}

function appendInline(target, line, depth = 0) {
  if (depth > 8) { target.append(line); return; }
  let position = 0;
  for (const token of line.matchAll(inlinePattern)) {
    const [value] = token;
    target.append(line.slice(position, token.index));
    position = token.index + value.length;
    if (value.startsWith('\x60')) {
      target.append(element('code', value.slice(1, -1)));
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
    if (link) {
      let address;
      try {
        const url = new URL(link[2]);
        if (url.protocol === 'https:' || url.protocol === 'http:') address = url.href;
      } catch {}
      if (address) {
        const anchor = element('a', link[1]);
        anchor.href = address;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        target.append(anchor);
      } else target.append(element('code', link[1]));
      continue;
    }
    const doubled = ['**', '__', '~~'].includes(value.slice(0, 2));
    const size = doubled ? 2 : 1;
    const inner = element(value.startsWith('~~') ? 's' : doubled ? 'strong' : 'em');
    appendInline(inner, value.slice(size, -size), depth + 1);
    target.append(inner);
  }
  target.append(line.slice(position));
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function tableStarts(lines, index) {
  return lines[index]?.includes('|') && lines[index + 1]?.includes('|') &&
    cells(lines[index + 1]).every(cell => /^:?-{3,}:?$/.test(cell));
}

function appendTable(target, lines, index) {
  const wrapper = element('div');
  wrapper.className = 'table-scroll';
  const table = element('table');
  const head = table.createTHead().insertRow();
  for (const label of cells(lines[index])) {
    const cell = element('th');
    cell.scope = 'col';
    appendInline(cell, label);
    head.append(cell);
  }
  const body = table.createTBody();
  index += 2;
  while (lines[index]?.includes('|')) {
    const row = body.insertRow();
    for (const value of cells(lines[index])) appendInline(row.insertCell(), value);
    index++;
  }
  wrapper.append(table);
  target.append(wrapper);
  return index;
}

export function renderMarkdown(source, depth = 0) {
  const output = document.createDocumentFragment();
  if (depth > 8) { output.append(source); return output; }
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = fenceStart.exec(line);
    if (fence) {
      const end = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      const body = [];
      i++;
      while (i < lines.length && !end.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      const block = element('div');
      block.className = 'code-block';
      if (fence[2]) {
        const language = element('span', fence[2]);
        language.className = 'code-language';
        block.append(language);
      }
      const pre = element('pre');
      pre.append(element('code', body.join('\n')));
      block.append(pre);
      output.append(block);
      continue;
    }
    const heading = headingStart.exec(line);
    if (heading) {
      const node = element('h' + Math.min(6, heading[1].length + 1));
      appendInline(node, heading[2]);
      output.append(node);
      i++;
      continue;
    }
    if (divider.test(line)) { output.append(element('hr')); i++; continue; }
    if (tableStarts(lines, i)) { i = appendTable(output, lines, i); continue; }
    if (quoteStart.test(line)) {
      const quote = element('blockquote');
      const body = [];
      while (i < lines.length) {
        const next = quoteStart.exec(lines[i]);
        if (!next) break;
        body.push(next[1]);
        i++;
      }
      quote.append(renderMarkdown(body.join('\n'), depth + 1));
      output.append(quote);
      continue;
    }
    const bullet = listStart.exec(line);
    if (bullet) {
      const ordered = /^\d/.test(bullet[1]);
      const list = element(ordered ? 'ol' : 'ul');
      if (ordered) list.start = parseInt(bullet[1], 10);
      while (i < lines.length) {
        const next = listStart.exec(lines[i]);
        if (!next || /^\d/.test(next[1]) !== ordered || divider.test(lines[i])) break;
        const item = element('li');
        appendInline(item, next[2]);
        list.append(item);
        i++;
      }
      output.append(list);
      continue;
    }
    const paragraph = element('p');
    appendInline(paragraph, line);
    i++;
    while (lines[i]?.trim() && !fenceStart.test(lines[i]) && !headingStart.test(lines[i]) && !listStart.test(lines[i]) &&
        !quoteStart.test(lines[i]) && !divider.test(lines[i]) && !tableStarts(lines, i)) {
      paragraph.append('\n');
      appendInline(paragraph, lines[i++]);
    }
    output.append(paragraph);
  }
  return output;
}
