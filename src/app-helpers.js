(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);
  }

  function markdownInline(value) {
    const codes = [];
    let text = escapeHtml(value).replace(/`([^`]+)`/g, (_, code) => {
      const key = "\u0000CODE" + codes.length + "\u0000";
      codes.push("<code>" + code + "</code>");
      return key;
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    codes.forEach((html, index) => {
      text = text.split("\u0000CODE" + index + "\u0000").join(html);
    });
    return text;
  }

  function markdownToHtml(markdown) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    const para = [];
    const stack = [];
    let inCode = false;
    let code = [];

    const flushPara = () => {
      if (!para.length) return;
      html.push("<p>" + markdownInline(para.join(" ")) + "</p>");
      para.length = 0;
    };
    const closeTopLi = () => {
      const top = stack[stack.length - 1];
      if (top && top.liOpen) {
        html.push("</li>");
        top.liOpen = false;
      }
    };
    const closeLists = (targetIndent) => {
      while (stack.length && (targetIndent == null || stack[stack.length - 1].indent > targetIndent)) {
        closeTopLi();
        html.push("</" + stack.pop().type + ">");
      }
    };
    const closeAllLists = () => closeLists(null);

    lines.forEach((line) => {
      if (/^\s*```/.test(line)) {
        flushPara();
        if (inCode) {
          html.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
          inCode = false;
          code = [];
        } else {
          closeAllLists();
          inCode = true;
          code = [];
        }
        return;
      }
      if (inCode) {
        code.push(line);
        return;
      }
      if (!line.trim()) {
        flushPara();
        closeAllLists();
        return;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushPara();
        closeAllLists();
        const level = Math.min(3, heading[1].length) + 2;
        html.push("<h" + level + ">" + markdownInline(heading[2]) + "</h" + level + ">");
        return;
      }
      const quote = line.match(/^>\s?(.+)$/);
      if (quote) {
        flushPara();
        closeAllLists();
        html.push("<blockquote>" + markdownInline(quote[1]) + "</blockquote>");
        return;
      }
      const item = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
      if (item) {
        flushPara();
        const indent = item[1].replace(/\t/g, "  ").length;
        const type = /\d+\./.test(item[2]) ? "ol" : "ul";
        closeLists(indent);
        let top = stack[stack.length - 1];
        if (!top || top.indent < indent || top.type !== type) {
          html.push("<" + type + ">");
          top = { type, indent, liOpen: false };
          stack.push(top);
        } else {
          closeTopLi();
        }
        html.push("<li>" + markdownInline(item[3]));
        top.liOpen = true;
        return;
      }
      closeAllLists();
      para.push(line.trim());
    });

    flushPara();
    closeAllLists();
    if (inCode) html.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
    return html.join("");
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value, label) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        key,
        label: label || key,
        message: (error && error.message) || "保存できませんでした。"
      };
    }
  }

  window.TPF = {
    ...(window.TPF || {}),
    escapeHtml,
    markdownInline,
    markdownToHtml,
    answerHtmlObj: (text) => ({ __html: markdownToHtml(text) }),
    readJson,
    writeJson
  };
})();
