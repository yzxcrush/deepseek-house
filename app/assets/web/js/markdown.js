/*!
 * DeepSeek House — markdown.js
 * 安全的 Markdown 渲染（先 HTML 转义，再按规则生成受控 HTML）。
 *
 * 入口：
 *   window.Markdown.render(text)
 *   window.Markdown.renderMarkdown(text)
 *   window.renderMarkdown(text)
 *
 * 支持：围栏代码块（语言标签 + 复制按钮 data-action="copy-code"）、行内 code、
 *       粗体/斜体/删除线、标题、有序/无序列表、引用、链接、表格、分隔线、换行。
 * 安全：不解析原始 HTML；链接仅允许 http/https/mailto，允许 target=_blank rel=noopener；
 *       javascript:/data:/vbscript:/file: 等一律不生成 <a>。
 * 流式：未闭合的围栏代码块会自动闭合渲染，并附加 md-code-open 类与「生成中…」提示。
 */
(function (global) {
  'use strict';

  var PLACEHOLDER_A = '\u0001';
  var PLACEHOLDER_B = '\u0002';
  var LINK_REL = ' target="_blank" rel="noopener noreferrer"';

  /* ------------------------------------------------------------------ *
   * 转义 / 安全
   * ------------------------------------------------------------------ */

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (ch) {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  /** 仅允许 http/https/mailto，其余返回 null（渲染为纯文本） */
  function sanitizeUrl(rawUrl) {
    if (rawUrl === null || rawUrl === undefined) return null;
    var url = String(rawUrl).replace(/^\s+|\s+$/g, '');
    if (!url) return null;
    // 用于 scheme 判断：去掉空白/控制字符与实体转义，防止 "java\nscript:" 绕过
    var compact = url.replace(/[\u0000-\u0020\u007f]+/g, '').replace(/&amp;/gi, '&').toLowerCase();
    if (/^(javascript|data|vbscript|file|blob|about):/.test(compact)) return null;
    if (!/^(https?:\/\/|mailto:)/.test(compact)) return null;
    return url;
  }

  function linkHtml(labelHtml, rawUrl) {
    var safe = sanitizeUrl(rawUrl);
    if (!safe) return labelHtml;
    return '<a href="' + safe + '"' + LINK_REL + '>' + labelHtml + '</a>';
  }

  /* ------------------------------------------------------------------ *
   * 行内渲染
   * ------------------------------------------------------------------ */

  function renderInline(text, depth) {
    depth = Number(depth) || 0;
    var src = text === null || text === undefined ? '' : String(text);
    src = src.replace(/[\u0001\u0002]/g, '');
    if (!src) return '';
    if (depth > 4) return src;

    var tokens = [];
    function stash(html) {
      tokens.push(html);
      return PLACEHOLDER_A + (tokens.length - 1) + PLACEHOLDER_B;
    }

    var out = src;

    // 1) 行内代码（优先，避免内部被其它规则改写）
    out = out.replace(/`([^`\n]+)`/g, function (m, code) {
      return stash('<code class="md-inline-code">' + code + '</code>');
    });

    // 2) 图片语法：不允许外链图片，降级为安全链接
    out = out.replace(/!\[([^\]\n]*)\]\(([^()\s]+)\)/g, function (m, alt, url) {
      var safe = sanitizeUrl(url);
      if (!safe) return alt;
      var label = alt ? renderInline(alt, depth + 1) : '🔗 链接';
      return stash('<a href="' + safe + '"' + LINK_REL + '>' + label + '</a>');
    });

    // 3) Markdown 链接
    out = out.replace(/\[([^\]\n]*)\]\(([^()\s]+)\)/g, function (m, label, url) {
      var safe = sanitizeUrl(url);
      if (!safe) return label;
      var inner = label ? renderInline(label, depth + 1) : safe;
      return stash('<a href="' + safe + '"' + LINK_REL + '>' + inner + '</a>');
    });

    // 4) 裸链接自动识别（http/https）
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+)/g, function (m, prefix, url) {
      var trailing = '';
      var tm = /[.,;:!?)\]}>。，；：！？、”’]+$/.exec(url);
      if (tm) {
        trailing = tm[0];
        url = url.slice(0, -trailing.length);
      }
      var safe = sanitizeUrl(url);
      if (!safe) return m;
      return prefix + stash('<a href="' + safe + '"' + LINK_REL + '>' + url + '</a>') + trailing;
    });

    // 5) 强调（在占位符之外执行）
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, function (m, prefix, inner) {
      return prefix + '<em>' + inner + '</em>';
    });
    out = out.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, function (m, prefix, inner) {
      return prefix + '<em>' + inner + '</em>';
    });

    // 6) 还原占位符（可能嵌套，循环几次）
    var guard = 0;
    while (out.indexOf(PLACEHOLDER_A) !== -1 && guard < 12) {
      guard++;
      out = out.replace(/\u0001(\d+)\u0002/g, function (m, idx) {
        var t = tokens[Number(idx)];
        return t === undefined ? m : t;
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 块级辅助
   * ------------------------------------------------------------------ */

  var FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`~]*)/;
  var HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
  var HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE_RE = /^\s{0,3}>/;
  var LIST_RE = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;

  function isTableSeparator(line) {
    if (line === null || line === undefined) return false;
    var s = String(line).replace(/^\s+|\s+$/g, '');
    if (s.indexOf('|') === -1 && !/^:?-{2,}:?$/.test(s)) return false;
    var cells = splitRow(s);
    if (!cells.length) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!/^:?-{2,}:?$/.test(cells[i])) return false;
    }
    return true;
  }

  function splitRow(line) {
    var s = String(line).replace(/^\s+|\s+$/g, '');
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.replace(/^\s+|\s+$/g, ''); });
  }

  function alignOf(cell) {
    var c = String(cell || '');
    var left = c.charAt(0) === ':';
    var right = c.charAt(c.length - 1) === ':';
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return '';
  }

  function alignAttr(align) {
    return align ? ' style="text-align:' + align + '"' : '';
  }

  function startsBlock(lines, i) {
    var line = lines[i];
    if (FENCE_RE.test(line)) return true;
    if (HEADING_RE.test(line)) return true;
    if (HR_RE.test(line)) return true;
    if (QUOTE_RE.test(line)) return true;
    if (LIST_RE.test(line)) return true;
    if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) return true;
    return false;
  }

  function renderCodeBlock(code, lang, closed) {
    var safeLang = String(lang || '').replace(/[^A-Za-z0-9_+.#-]/g, '').slice(0, 24);
    var langHtml = safeLang
      ? '<span class="md-code-lang">' + escapeHtml(safeLang) + '</span>'
      : '<span class="md-code-lang">代码</span>';
    var hint = closed ? '' : '<span class="md-code-open-hint">生成中…</span>';
    return '<div class="md-code' + (closed ? '' : ' md-code-open') + '">' +
      '<div class="md-code-head">' + langHtml + hint +
      '<button type="button" class="md-code-copy" data-action="copy-code" aria-label="复制代码">复制</button>' +
      '</div>' +
      '<pre class="md-pre"><code class="md-code-body' + (safeLang ? ' language-' + safeLang : '') + '">' +
      code +
      '</code></pre></div>';
  }

  function renderTable(headerCells, alignCells, rows) {
    var i;
    var html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    for (i = 0; i < headerCells.length; i++) {
      html += '<th' + alignAttr(alignCells[i]) + '>' + renderInline(escapeHtml(headerCells[i])) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      html += '<tr>';
      for (i = 0; i < headerCells.length; i++) {
        var cell = row[i] === undefined ? '' : row[i];
        html += '<td' + alignAttr(alignCells[i]) + '>' + renderInline(escapeHtml(cell)) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  /* ------------------------------------------------------------------ *
   * 主渲染
   * ------------------------------------------------------------------ */

  function render(text) {
    if (text === null || text === undefined) return '';
    var src = String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u0001\u0002]/g, '');
    if (!src) return '';
    // 注意：块级解析基于「未转义」的原始行（否则 > 会变成 &gt;、表格 | 仍可用），
    // 行内内容在 renderInline 前才逐段 escapeHtml，代码块内容单独转义。
    var lines = src.split('\n');
    var out = [];
    var i = 0;
    var n = lines.length;

    while (i < n) {
      var line = lines[i];

      // 空行
      if (/^\s*$/.test(line)) { i++; continue; }

      // 围栏代码块
      var fm = FENCE_RE.exec(line);
      if (fm) {
        var fenceChar = fm[2].charAt(0);
        var fenceLen = fm[2].length;
        var lang = fm[3] || '';
        var buf = [];
        var closed = false;
        i++;
        var closeRe = new RegExp('^\\s{0,3}' + (fenceChar === '`' ? '`' : '~') + '{' + fenceLen + ',}\\s*$');
        while (i < n) {
          if (closeRe.test(lines[i])) { closed = true; i++; break; }
          buf.push(lines[i]);
          i++;
        }
        out.push(renderCodeBlock(escapeHtml(buf.join('\n')), lang, closed));
        continue;
      }

      // 分隔线
      if (HR_RE.test(line)) {
        out.push('<hr class="md-hr">');
        i++;
        continue;
      }

      // 标题
      var hm = HEADING_RE.exec(line);
      if (hm) {
        var level = Math.min(6, Math.max(1, hm[1].length));
        var htext = hm[2].replace(/\s+#+\s*$/, '');
        out.push('<h' + level + ' class="md-h">' + renderInline(escapeHtml(htext)) + '</h' + level + '>');
        i++;
        continue;
      }

      // 表格
      if (line.indexOf('|') !== -1 && i + 1 < n && isTableSeparator(lines[i + 1])) {
        var headerCells = splitRow(line);
        var alignCells = splitRow(lines[i + 1]).map(alignOf);
        i += 2;
        var rows = [];
        while (i < n && lines[i].replace(/^\s+|\s+$/g, '') !== '' && lines[i].indexOf('|') !== -1) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push(renderTable(headerCells, alignCells, rows));
        continue;
      }

      // 引用
      if (QUOTE_RE.test(line)) {
        var quoteLines = [];
        while (i < n && QUOTE_RE.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        var quoteHtml = quoteLines.map(function (q) { return renderInline(escapeHtml(q)); }).join('<br>');
        out.push('<blockquote class="md-quote">' + quoteHtml + '</blockquote>');
        continue;
      }

      // 列表
      var lm = LIST_RE.exec(line);
      if (lm) {
        var ordered = !/^[-*+]$/.test(lm[1]);
        var items = [];
        while (i < n) {
          var im = LIST_RE.exec(lines[i]);
          if (!im) break;
          var itemOrdered = !/^[-*+]$/.test(im[1]);
          if (itemOrdered !== ordered) break;
          var itemText = im[2];
          i++;
          while (i < n && lines[i].replace(/^\s+|\s+$/g, '') !== '' &&
            !LIST_RE.test(lines[i]) && /^\s{2,}\S/.test(lines[i])) {
            itemText += '\n' + lines[i].replace(/^\s+/, '');
            i++;
          }
          items.push(itemText);
        }
        var tag = ordered ? 'ol' : 'ul';
        var listHtml = items.map(function (item) {
          return '<li>' + renderInline(escapeHtml(item)).replace(/\n/g, '<br>') + '</li>';
        }).join('');
        out.push('<' + tag + ' class="md-list">' + listHtml + '</' + tag + '>');
        continue;
      }

      // 段落（直到空行或下一个块级元素）
      var para = [line];
      i++;
      while (i < n && lines[i].replace(/^\s+|\s+$/g, '') !== '' && !startsBlock(lines, i)) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p class="md-p">' + para.map(function (p) { return renderInline(escapeHtml(p)); }).join('<br>') + '</p>');
    }

    return out.join('\n');
  }

  var api = {
    render: render,
    renderMarkdown: render,
    escapeHtml: escapeHtml,
    sanitizeUrl: sanitizeUrl
  };

  global.Markdown = api;
  global.renderMarkdown = render;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
