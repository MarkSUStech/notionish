/* ============ Notionish Web Clipper - Content Script ============ */
"use strict";

// ---- 评分式正文提取（移植 defuddle，不丢图片和代码块） ----
function findContentByScoring(doc) {
  const navWords = /\b(advertisement|all rights reserved|banner|cookie|comments|copyright|follow|footer|header|homepage|login|menu|more articles|more like this|most read|nav|navigation|newsletter|popular|privacy|recommended|register|related|responses|share|sidebar|sign in|sign up|signup|social|sponsored|subscribe|terms|trending)\b/i;
  let best = null, bestScore = 0;
  const body = doc.body || doc;
  body.querySelectorAll("p, div, article, section, main, td").forEach(function(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "p" && (el.textContent || "").trim().length < 80) return;
    const cls = (el.className || "").toLowerCase();
    const id = (el.id || "").toLowerCase();
    let navPenalty = 0;
    if (navWords.test(cls) || navWords.test(id)) navPenalty = -200;
    if (/(sidebar|nav|menu|footer|header|related|recommend|comment|breadcrumb|pagination|widget|advert|banner|cookie|social|share|subscribe)/i.test(cls) && !/(article|content|post|entry|viewer|story|main)/i.test(cls)) navPenalty = -200;
    const text = el.textContent || "";
    const words = text.split(/\s+/).length;
    const paragraphs = el.getElementsByTagName("p").length;
    const commas = (text.match(/,/g) || []).length;
    const images = el.getElementsByTagName("img").length;
    const imageDensity = images / (words || 1);
    let score = words + paragraphs * 10 + commas - imageDensity * 3 + navPenalty;
    if (/(content|article|post|entry|viewer|story|main)/i.test(cls)) score += 50;
    if (/(content|article|post|entry|main)/i.test(id)) score += 50;
    if (el.querySelector("h1, h2, h3, h4, h5, h6")) score += 30;
    if (score > bestScore) { bestScore = score; best = el; }
  });
  return best && bestScore > 50 ? best : null;
}

function standardizeImages(container, baseUrl) {
  // 解包只包含图片的 <a> 标签（Wikipedia 图片链接到 File 描述页，无意义）
  container.querySelectorAll("a").forEach(function(a) {
    var imgs = a.querySelectorAll("img");
    if (imgs.length === 1 && a.childNodes.length === 1) {
      a.replaceWith(imgs[0]);
    } else if (imgs.length === 1) {
      // 检查是否只有图片 + 空白文本
      var text = a.textContent || "";
      var imgText = imgs[0].textContent || "";
      if (text.trim() === imgText.trim()) a.replaceWith(imgs[0]);
    }
  });
  // 标准化图片 src
  container.querySelectorAll("img").forEach(function(img) {
    var src = img.getAttribute("src") || "";
    var dataSrc = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src") || "";
    var isPlaceholder = !src || (/^data:image\/(?:gif|png)/i.test(src) && src.length < 300) || /^data:image\/svg\+xml/i.test(src);
    if (isPlaceholder && dataSrc) {
      var realSrc = dataSrc.split(/\s+/)[0].replace(/^,\s*/, "");
      if (realSrc && !/^data:/i.test(realSrc)) {
        try { img.setAttribute("src", new URL(realSrc, baseUrl).href); } catch(e) { img.setAttribute("src", realSrc); }
      }
    }
    var srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
    if (srcset) {
      var bestW = 0, bestUrl = src, parts = srcset.trim().split(/\s+/), urlParts = [];
      for (var i = 0; i < parts.length; i++) {
        var t = parts[i];
        var wm = t.match(/^(\d+)w,?$/);
        if (wm) { var w = parseInt(wm[1]); if (urlParts.length > 0 && w > bestW) { bestW = w; bestUrl = urlParts.join(" ").replace(/^,\s*/, ""); } urlParts = []; }
        else if (/^\d+(?:\.\d+)?x,?$/.test(t)) { urlParts = []; }
        else { urlParts.push(t); }
      }
      if (bestUrl && bestUrl !== src) {
        try { img.setAttribute("src", new URL(bestUrl, baseUrl).href); } catch(e) { img.setAttribute("src", bestUrl); }
      }
    }
    var finalSrc = img.getAttribute("src") || "";
    if (finalSrc && !/^data:/i.test(finalSrc)) {
      try { img.setAttribute("src", new URL(finalSrc, baseUrl).href); } catch(e) {}
    }
    img.removeAttribute("data-src"); img.removeAttribute("data-srcset"); img.removeAttribute("data-original");
    img.removeAttribute("loading"); img.classList.remove("lazy", "lazyload");
  });
}

function standardizeCodeBlocks(container) {
  Array.from(container.querySelectorAll("*")).reverse().forEach(function(el) {
    if (el.tagName.includes("-") && el.tagName.toLowerCase() !== "gfg-tab" && el.tagName.toLowerCase() !== "gfg-tab-item") {
      var div = document.createElement("div");
      while (el.firstChild) div.appendChild(el.firstChild);
      var lang = el.getAttribute("data-code-lang");
      if (lang) div.setAttribute("data-lang", lang);
      el.replaceWith(div);
    }
  });
  Array.from(container.querySelectorAll(".highlight, div[class*='language-'], .code-block[data-lang]")).reverse().forEach(function(el) {
    if (el.closest("pre")) return;
    var lang = el.getAttribute("data-lang") || el.getAttribute("data-language") || "";
    if (!lang) { var lm = (el.getAttribute("class") || "").match(/language-(\w+)/); if (lm) lang = lm[1]; }
    if (!lang) {
      var p = el.parentElement;
      while (p && !lang) {
        lang = p.getAttribute("data-lang") || p.getAttribute("data-language") || "";
        if (!lang) { var lm2 = (p.getAttribute("class") || "").match(/language-(\w+)/); if (lm2) lang = lm2[1]; }
        p = p.parentElement;
      }
    }
    var pre = document.createElement("pre");
    var code = document.createElement("code");
    if (lang) { code.setAttribute("data-lang", lang); }
    code.textContent = (el.textContent || "").replace(/\t/g, "    ").trim();
    pre.appendChild(code);
    el.replaceWith(pre);
  });
  Array.from(container.querySelectorAll("code > pre")).reverse().forEach(function(pre) {
    var outerCode = pre.parentElement;
    var lang = (outerCode.getAttribute("class") || "").match(/language-(\w+)/);
    if (lang) {
      var innerCode = pre.querySelector("code");
      if (!innerCode) { innerCode = document.createElement("code"); innerCode.textContent = pre.textContent || ""; pre.innerHTML = ""; pre.appendChild(innerCode); }
      innerCode.setAttribute("data-lang", lang[1]);
    }
    outerCode.replaceWith(pre);
  });
}

// ---- 噪音移除（移植 defuddle：隐藏元素 + 精确/部分选择器 + 小图标） ----
function removeNoise(container) {
  // 1. 精确选择器：script/style/导航/页脚/广告/社交/元信息等
  var exactSelectors = [
    "script", "style", "noscript", "meta", "link",
    "nav", "footer", "header", "form", "button", "canvas", "dialog", "fieldset",
    "select", "textarea", "label", "option", "date",
    ".sidebar", ".Sidebar", "#sidebar", "#Sidebar", "#secondary",
    ".ad", "[class^='ad-']", "[class$='-ad']", "[id^='ad-']", ".promo", ".alert",
    ".author", ".Author", ".date", ".meta", ".entry-meta", ".tags", "#tags",
    ".headline", "#headline", "#title", "#Title", ".contributor",
    ".toc", ".Toc", "#toc", ".noprint",
    ".menu", ".navigation", "#navigation", "[role='navigation']", "[role='banner']",
    ".subscribe", "#newsletter", ".copyright", "#copyright",
    ".breadcrumb", ".crumbs", ".pagination", ".previous", ".next",
    ".share", ".social", "[class*='share-']", "[class*='social-']",
    ".comment", "#comments", "[id='comment']", "[class*='comment-']",
    ".related", "[class*='related']", ".recommend", "[class*='recommend']",
    ".jump-link", ".skip-link", "[class*='skip']", "[aria-label*='skip']",
    ".gutter", "#rss", "#feed", ".logo", "#logo",
    "table.infobox", ".infobox", ".navbox", ".mw-editsection", ".mw-empty-elt",
    ".sistersitebox", ".metadata", ".ambox", ".shortdescription", ".hatnote",
    ".reflist", ".refbegin", ".authority-control", ".mw-jump-link",
    ".printfooter", ".catlinks", ".mw-indicators", ".mw-cite-backlink",
    ".gallery", ".thumbcaption", ".mw-headline-anchor"
  ];
  container.querySelectorAll(exactSelectors.join(",")).forEach(function(el) {
    if (el.closest("pre, code, math")) return; // 保护代码块和公式
    el.remove();
  });

  // 2. 部分选择器：class/id 里包含这些噪音关键词
  var partialPattern = /\b(advert|ad-|-ad|banner|cookie|breadcrumb|comments|comment-|copyright|footer|header|homepage|login|menu|newsletter|popular|privacy|recommended|register|related|responses|share|sidebar|sign.?in|sign.?up|social|sponsored|subscribe|terms|trending|byline|avatar|author-bio|author-box|meta|date|tags|category|pagination|prev|next|promo|widget|newsletter|disqus|facebook|twitter|donate|feedback|carousel|gallery|lightbox|popup|modal|tooltip|dropdown|masthead|site-header|site-name|page-header|post-header|post-title|entry-title|page-title|read-more|keep-reading|more-|related-|similar-|outline|breadcrumb|nav-|menu-|skip-|visually-hidden|screen-reader|sr-only|hidden-|no-print|print-|hamburger|back-to-top|scroll-to|goog-|google-)/i;
  container.querySelectorAll("[class], [id]").forEach(function(el) {
    if (el.closest("pre, code, math")) return;
    var cls = (el.className || "").toString();
    var id = (el.id || "").toString();
    // 只删明显噪音，保留正文容器
    if (/article|content|post|entry|story|main|text|body|section/i.test(cls + " " + id)) return;
    if (partialPattern.test(cls) || partialPattern.test(id)) {
      el.remove();
    }
  });

  // 3. 隐藏元素（display:none / visibility:hidden / hidden class）
  container.querySelectorAll("*").forEach(function(el) {
    if (el.closest("pre, code, math")) return;
    // 保留含公式的元素（MathML 常在 display:none 的 span 里）
    if (el.querySelector("math, .katex-mathml, [data-mathml]") || el.tagName.toLowerCase() === "math") return;
    var style = (el.getAttribute("style") || "");
    if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/i.test(style)) {
      el.remove();
      return;
    }
    var cls = (el.className || "").toString();
    var tokens = cls.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (tok === "hidden" || tok === "invisible" || tok === "sr-only" || tok === "visually-hidden" || tok === "screen-reader-text") {
        el.remove();
        break;
      }
    }
  });

  // 4. 小图标移除（<33px 的 img/svg，通常是图标/spacer）
  container.querySelectorAll("img, svg").forEach(function(el) {
    var w = parseInt(el.getAttribute("width") || "0");
    var h = parseInt(el.getAttribute("height") || "0");
    if (w > 0 && w < 33) { el.remove(); return; }
    if (h > 0 && h < 33) { el.remove(); return; }
    // SVG 图标（viewBox 小，或无 viewBox）
    if (el.tagName.toLowerCase() === "svg") {
      var vb = el.getAttribute("viewBox") || "";
      var parts = vb.split(/[\s,]+/);
      if (parts.length === 4) {
        var vw = parseFloat(parts[2]) || 0;
        var vh = parseFloat(parts[3]) || 0;
        if (vw > 0 && vw < 33) { el.remove(); return; }
        if (vh > 0 && vh < 33) { el.remove(); return; }
      }
    }
  });
}

function extractAndClip() {
  var title = document.title || "";
  var url = location.href;
  var doc = document;

  var container = null;
  if (/wikipedia\.org/i.test(url)) {
    container = doc.querySelector(".mw-parser-output") || doc.querySelector("#mw-content-text");
  }
  if (!container && /geeksforgeeks\.org/i.test(url)) {
    container = doc.querySelector('.article--viewer, [class*="article--viewer"]');
  }
  if (!container) {
    container = findContentByScoring(doc);
  }
  if (!container && typeof Readability !== "undefined") {
    try {
      var article = new Readability(doc.cloneNode(true)).parse();
      if (article && article.content) {
        var tmp = document.createElement("div");
        tmp.innerHTML = article.content;
        container = tmp;
      }
    } catch(e) {}
  }
  if (!container) {
    container = doc.body;
  }

  // 克隆，避免修改页面 DOM
  container = container.cloneNode(true);

  // 用 innerHTML 重新解析（和 app.js 同样的方式，更可靠地保留图片）
  var parser = new DOMParser();
  var cdoc = parser.parseFromString(
    container.outerHTML || container.innerHTML,
    "text/html"
  );
  standardizeImages(cdoc.body || cdoc, url);
  standardizeCodeBlocks(cdoc.body || cdoc);
  removeNoise(cdoc.body || cdoc);

  var markdown = "";
  if (typeof TurndownService !== "undefined") {
    var td = new TurndownService({
      headingStyle: "atx", codeBlockStyle: "fenced",
      bulletListMarker: "-", emDelimiter: "*", preformattedCode: true
    });
    td.remove(["style", "script"]);
    td.addRule("link", { filter: "a", replacement: function(content, node) {
      var href = node.getAttribute("href") || "";
      if (!href) return content;
      try { href = new URL(href, url).href; } catch(e) {}
      content = content.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
      return "[" + content + "](" + href + ")";
    }});
    td.addRule("image", { filter: "img", replacement: function(content, node) {
      // 跳过公式渲染图（由 math 规则处理）
      if (node.closest && (node.closest(".mwe-math-element") || node.closest("math") || node.closest(".katex"))) return "";
      var alt = node.getAttribute("alt") || "";
      var src = node.getAttribute("src") || "";
      if (src && !/^data:/i.test(src)) { try { src = new URL(src, url).href; } catch(e) {} }
      return src ? "![" + alt + "](" + src.replace(/([()])/g, "\\$1") + ")" : "";
    }});
    td.addRule("preformattedCode", { filter: "pre", replacement: function(content, node) {
      var codeEl = node.querySelector("code");
      var lang = codeEl ? (codeEl.getAttribute("data-lang") || "") : "";
      var text = codeEl ? (codeEl.textContent || "") : (node.textContent || "");
      return "\n```" + lang + "\n" + text.trim().replace(/`/g, "\\`") + "\n```\n";
    }});
    td.addRule("math", { filter: function(node) {
      var nn = node.nodeName.toLowerCase();
      return nn === "math" || (node.classList && (
        node.classList.contains("mwe-math-element") ||
        node.classList.contains("mwe-math-fallback-image-inline") ||
        node.classList.contains("mwe-math-fallback-image-display") ||
        node.classList.contains("math") ||
        node.classList.contains("katex")
      ));
    }, replacement: function(content, node) {
      var ann = node.querySelector('annotation[encoding="application/x-tex"]');
      var latex = (ann && ann.textContent ? ann.textContent.trim() : "");
      if (!latex) latex = (node.getAttribute("data-latex") || "").trim();
      if (!latex) {
        var kmml = node.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
        latex = (kmml && kmml.textContent ? kmml.textContent.trim() : "");
      }
      if (!latex) latex = (node.getAttribute("alttext") || "").trim();
      if (!latex && node.querySelector("img")) {
        latex = (node.querySelector("img").getAttribute("alt") || "").trim();
      }
      if (!latex) return content;
      var isBlock = node.getAttribute("display") === "block"
        || node.classList.contains("mwe-math-fallback-image-display")
        || (node.parentNode && node.parentNode.nodeName === "P" && node.parentNode.children.length === 1);
      if (isBlock) {
        if (latex.includes("\\\\") || latex.includes("&")) {
          if (!/\\begin\{/.test(latex)) latex = "\\begin{aligned}\n" + latex + "\n\\end{aligned}";
        }
        return "\n$$\n" + latex + "\n$$\n";
      }
      return "$" + latex + "$";
    }});
    td.addRule("gfgTab", { filter: function(node) {
      return node.nodeName.toLowerCase() === "gfg-tab";
    }, replacement: function() { return ""; }});
    markdown = td.turndown(cdoc.body || cdoc);
    markdown = markdown.replace(/\n{3,}/g, "\n\n");
  } else {
    markdown = ((cdoc.body || cdoc).textContent || "").replace(/\n{3,}/g, "\n\n");
  }

  return { title: title, markdown: markdown, url: url };
}

// 返回提取结果给 popup（popup 负责发请求到服务器，避免 CSP 限制）
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === "clip") {
    try {
      var result = extractAndClip();
      sendResponse({ ok: true, title: result.title, markdown: result.markdown, url: result.url });
    } catch(e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
});