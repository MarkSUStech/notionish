/* ============ PDF viewer page (PDF.js canvas + text layer + highlighter) ============ */
(function (global) {
  "use strict";

  const PDFJS_URL = "vendor/pdfjs/pdf.min.js";
  const PDFJS_WORKER = "vendor/pdfjs/pdf.worker.min.js";

  let _pdfjsPromise = null;
  function loadPdfjs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PDFJS_URL;
      s.async = true;
      s.onload = () => { if (global.pdfjsLib) resolve(global.pdfjsLib); else { _pdfjsPromise = null; reject(new Error("PDF.js 未就绪")); } };
      s.onerror = () => { _pdfjsPromise = null; reject(new Error("无法加载 PDF 渲染库")); };
      document.head.appendChild(s);
    });
    return _pdfjsPromise;
  }

  function base64ToUint8(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** 把同一行（垂直重叠）的碎片矩形合并成整行高亮条，避免高亮断开 */
  function mergeRects(rects) {
    if (!rects || !rects.length) return [];
    const sorted = rects.slice().sort((a, b) => a.top - b.top || a.left - b.left);
    const merged = [];
    for (const r of sorted) {
      const last = merged[merged.length - 1];
      if (last && r.top < last.bottom && r.bottom > last.top) {
        last.left = Math.min(last.left, r.left);
        last.right = Math.max(last.right, r.right);
        last.top = Math.min(last.top, r.top);
        last.bottom = Math.max(last.bottom, r.bottom);
      } else {
        merged.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
    }
    return merged;
  }

  const viewByRoot = new WeakMap();

  const PDFViewer = {
    mergeRects,
    page: null,
    doc: null,
    scale: 1.3,
    autoUpload: false,
    focusHighlight: null,
    focusImage: null,
    rendered: null,     // Map pageNum -> { wrap, hlLayer, imgLayer, viewport }
    _pageSizes: null,
    _imageCache: null,  // Map pageNum -> [{id,page,x,y,w,h,dataUrl}]（已提取图片的临时缓存）
    _observer: null,
    _zoomTimer: null,
    _zoomBase: null,     // 缩放期间页面实际渲染所用的 scale（用于 CSS transform 预览缩放）
    _generation: 0,

    _newView(content) {
      const view = Object.create(PDFViewer);
      view.scale = this.scale;
      view.autoUpload = this.autoUpload;
      view.focusHighlight = this.focusHighlight;
      view.focusImage = this.focusImage;
      view.page = null;
      view.doc = null;
      view.rendered = null;
      view._pageSizes = null;
      view._imageCache = new Map();
      view._observer = null;
      view._zoomTimer = null;
      view._zoomBase = null;
      view._generation = 0;
      view._root = content;
      return view;
    },

    _dispose() {
      this._generation++;
      if (this._observer) this._observer.disconnect();
      this._observer = null;
      if (this._zoomTimer) clearTimeout(this._zoomTimer);
      this._zoomTimer = null;
      this._zoomBase = null;
    },

    render(page) {
      const content = U.renderRoot();
      if (this === PDFViewer) {
        const previous = viewByRoot.get(content);
        if (previous) previous._dispose();
        const view = this._newView(content);
        viewByRoot.set(content, view);
        this.autoUpload = false;
        this.focusHighlight = null;
        return view.render(page);
      }

      this._dispose();
      this.page = page;
      this.doc = null;
      this.rendered = null;
      this._pageSizes = null;
      content.innerHTML = "";

      const wrap = U.el("div", "pdf-page");
      const bar = U.el("div", "web-bar");

      const input = U.el("input", "web-url");
      input.type = "text";
      input.spellcheck = false;
      input.placeholder = "输入 PDF 网址，或点「上传」选择本地 PDF";
      input.value = /^data:/i.test(page.url || "") ? "" : (page.url || "");

      const pageInput = U.el("input", "pdf-page-input");
      pageInput.type = "number";
      pageInput.min = 1;
      pageInput.value = page.page || 1;
      pageInput.title = "跳转到第几页";

      const hlBtn = U.el("button", "web-btn", "🖍");
      hlBtn.title = "高亮选中文字（荧光笔）";

      const zoomOut = U.el("button", "web-btn", "−");
      zoomOut.title = "缩小";
      const zoomIn = U.el("button", "web-btn", "＋");
      zoomIn.title = "放大";

      const upload = U.el("button", "web-btn", "上传");
      upload.title = "上传本地 PDF";
      const fileInput = U.el("input", null);
      fileInput.type = "file";
      fileInput.accept = "application/pdf,.pdf";
      fileInput.hidden = true;

      const open = U.el("button", "web-btn", "↗");
      open.title = "在新标签页打开";

      bar.appendChild(input);
      bar.appendChild(pageInput);
      bar.appendChild(hlBtn);
      bar.appendChild(zoomOut);
      bar.appendChild(zoomIn);
      bar.appendChild(upload);
      bar.appendChild(open);
      wrap.appendChild(bar);

      const status = U.el("div", "pdf-status", "加载中…");
      wrap.appendChild(status);

      const pages = U.el("div", "pdf-pages");
      wrap.appendChild(pages);
      content.appendChild(wrap);

      this.pagesEl = pages;
      this.statusEl = status;
      this.pageInputEl = pageInput;

      const reload = () => {
        const raw = input.value.trim();
        if (raw) {
          page.url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
          global.Store.touch(page);
          global.Store.markDirty();
        }
        this.load();
      };
      input.addEventListener("keydown", e => { if (e.key === "Enter") reload(); });
      pageInput.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          const max = this.doc ? this.doc.numPages : Infinity;
          const n = Math.min(max, Math.max(1, parseInt(pageInput.value, 10) || 1));
          page.page = n;
          global.Store.touch(page);
          global.Store.markDirty();
          this.scrollToPage(n);
        }
      });
      hlBtn.addEventListener("click", () => this.createHighlightFromSelection());
      zoomIn.addEventListener("click", () => this.zoomBy(0.2));
      zoomOut.addEventListener("click", () => this.zoomBy(-0.2));
      open.addEventListener("click", () => { if (page.url) window.open(page.url, "_blank"); });
      upload.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!f) return;
        U.fileToDataURL(f).then(dataUrl => { page.url = dataUrl; input.value = ""; this.load(); });
      });

      // Ctrl + 滚轮缩放（防抖，保持当前页）
      pages.addEventListener("wheel", e => {
        if (!e.ctrlKey || e.deltaY === 0) return;
        e.preventDefault();
        if (e.deltaY < 0) this.zoomBy(0.15);
        else this.zoomBy(-0.15);
      }, { passive: false });
      const rememberPage = U.debounce(() => {
        if (!this.doc || this._zoomBase != null) return;
        const n = this.currentPageFromScroll();
        if (n === page.page) return;
        page.page = n;
        pageInput.value = n;
        global.Store.touch(page);
        global.Store.markDirty();
      }, 180);
      pages.addEventListener("scroll", rememberPage, { passive: true });

      if (this.autoUpload) {
        this.autoUpload = false;
        setTimeout(() => fileInput.click(), 60);
      }

      if (page.url) this.load();
      else this.statusEl.textContent = "输入 PDF 网址或上传本地文件";
    },

    async load() {
      const generation = ++this._generation;
      const page = this.page;
      const url = page.url || "";
      if (!url) { this.statusEl.textContent = "无 PDF 源"; return; }
      this.statusEl.textContent = "加载中…";
      try {
        const pdfjsLib = await loadPdfjs();
        if (generation !== this._generation) return;
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        const src = /^data:/i.test(url) ? { data: base64ToUint8(url.slice(url.indexOf(",") + 1)) } : { url };
        const doc = await pdfjsLib.getDocument(src).promise;
        if (generation !== this._generation) { if (doc.destroy) doc.destroy(); return; }
        const sizes = await Promise.all(Array.from({ length: doc.numPages }, async (_, index) => {
          const pdfPage = await doc.getPage(index + 1);
          const viewport = pdfPage.getViewport({ scale: 1.0 });
          return { width: viewport.width, height: viewport.height };
        }));
        if (generation !== this._generation) { if (doc.destroy) doc.destroy(); return; }
        this.doc = doc;
        this._pageSizes = sizes;
        this.buildSkeleton(generation);
        const initialPage = this.scrollToPage(page.page || 1);
        if (page.page !== initialPage) {
          page.page = initialPage;
          global.Store.touch(page);
          global.Store.markDirty();
        }
        if (this.focusHighlight) {
          const hl = (page.highlights || []).find(x => x.id === this.focusHighlight);
          this.focusHighlight = null;
          if (hl) { this.scrollToPage(hl.page); this.flashHighlight(hl.id); }
        }
        if (this.focusImage) {
          const im = (page.images || []).find(x => x.id === this.focusImage);
          this.focusImage = null;
          if (im) { this.scrollToPage(im.page); this.flashImage(im.id); }
        }
      } catch (e) {
        if (generation !== this._generation) return;
        this.statusEl.textContent = "";
        this.showFallback(url, e);
      }
    },

    buildSkeleton(generation) {
      if (!this.doc || (generation != null && generation !== this._generation)) return;
      this.rendered = new Map();
      this.pagesEl.innerHTML = "";
      for (let i = 1; i <= this.doc.numPages; i++) {
        const size = this._pageSizes && this._pageSizes[i - 1];
        const width = Math.max(1, Math.round((size ? size.width : 600) * this.scale));
        const height = Math.max(120, Math.round((size ? size.height : 800) * this.scale));
        const ph = U.el("div", "pdf-page-ph");
        ph.dataset.page = i;
        ph.style.width = width + "px";
        ph.style.height = (height + 25) + "px";
        ph.textContent = "…";
        this.pagesEl.appendChild(ph);
      }
      this.updateStatus();
      this.setupObserver();
    },

    setupObserver() {
      if (this._observer) this._observer.disconnect();
      const generation = this._generation;
      if (typeof IntersectionObserver === "undefined") {
        for (let i = 1; i <= this.doc.numPages; i++) this.renderPageLazy(i, generation);
        return;
      }
      this._observer = new IntersectionObserver(entries => {
        if (generation !== this._generation) return;
        entries.forEach(en => {
          if (en.isIntersecting) this.renderPageLazy(parseInt(en.target.dataset.page, 10), generation);
        });
      }, { root: this.pagesEl, rootMargin: "600px 0px" });
      this.pagesEl.querySelectorAll(".pdf-page-ph").forEach(ph => this._observer.observe(ph));
    },

    async renderPageLazy(num, generation) {
      generation = generation == null ? this._generation : generation;
      if (generation !== this._generation || !this.doc || this.rendered.has(num)) return;
      const doc = this.doc;
      const ph = this.pagesEl.querySelector('[data-page="' + num + '"]');
      if (!ph || ph.dataset.rendering === "1") return;
      ph.dataset.rendering = "1";
      try {
        const pdfPage = await doc.getPage(num);
        if (generation !== this._generation || doc !== this.doc || !ph.isConnected) return;
        const viewport = pdfPage.getViewport({ scale: this._renderScale() });
        const wrap = U.el("div", "pdf-canvas-wrap");
        wrap.dataset.page = num;
        this._setPageBox(wrap, num);
        const inner = U.el("div", "pdf-page-inner");
        inner.style.width = viewport.width + "px";
        inner.style.height = viewport.height + "px";
        this._applyZoomTransformTo(inner);

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const dpr = global.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = viewport.width + "px";
        canvas.style.height = viewport.height + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        if (generation !== this._generation || doc !== this.doc || !ph.isConnected) return;
        inner.appendChild(canvas);

        wrap.appendChild(inner);
        const label = U.el("div", "pdf-page-label", num + " / " + doc.numPages);
        wrap.appendChild(label);
        ph.replaceWith(wrap);

        // 文本层（可选中的文字），再叠加高亮层和图片层（图片层在最上，可点击）
        await this.renderTextLayer(pdfPage, viewport, inner);
        if (generation !== this._generation || doc !== this.doc || !wrap.isConnected) return;
        const hlLayer = U.el("div", "pdf-hl-layer");
        inner.appendChild(hlLayer);
        const imgLayer = U.el("div", "pdf-img-layer");
        inner.appendChild(imgLayer);
        this.rendered.set(num, { wrap, hlLayer, imgLayer, viewport });
        this.drawHighlights(num);
        this.drawPageImages(num);
      } catch (e) {
        if (generation === this._generation && ph.isConnected) delete ph.dataset.rendering;
      }
    },

    async renderTextLayer(pdfPage, viewport, inner) {
      try {
        const textContent = await pdfPage.getTextContent();
        const layer = document.createElement("div");
        layer.className = "pdf-text-layer";
        // PDF.js 文本层依赖 --scale-factor 定位文字/字号，必须等于 viewport.scale
        layer.style.setProperty("--scale-factor", String(viewport.scale));
        const task = global.pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: layer,
          viewport: viewport,
          textDivs: [],
        });
        await task.promise;
        inner.appendChild(layer);
      } catch (e) { console.error("text layer", e); }
    },

    drawHighlights(num) {
      const entry = this.rendered.get(num);
      if (!entry) return;
      entry.hlLayer.innerHTML = "";
      const viewport = entry.viewport;
      (this.page.highlights || []).filter(h => h.page === num).forEach(h => {
        (h.rects || []).forEach(rect => {
          if (!rect || rect.length < 4) return;
          const p1 = viewport.convertToViewportPoint(rect[0], rect[1]);
          const p2 = viewport.convertToViewportPoint(rect[2], rect[3]);
          const div = U.el("div", "pdf-hl");
          div.style.left = Math.min(p1[0], p2[0]) + "px";
          div.style.top = Math.min(p1[1], p2[1]) + "px";
          div.style.width = Math.abs(p2[0] - p1[0]) + "px";
          div.style.height = Math.abs(p2[1] - p1[1]) + "px";
          div.style.background = h.color || "#ffe58f";
          div.dataset.highlightId = h.id;
          div.title = "点击管理此高亮";
          div.addEventListener("click", e => {
            e.stopPropagation();
            this.showHighlightMenu(h, e.clientX, e.clientY);
          });
          entry.hlLayer.appendChild(div);
        });
      });
    },

    createHighlightFromSelection() {
      if (this._zoomBase != null) {
        if (this._zoomTimer) clearTimeout(this._zoomTimer);
        this._zoomTimer = null;
        this.commitZoom();
        U.toast("缩放完成后请重新选择文字");
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { U.toast("请先在 PDF 里选中要标注的文字"); return; }
      const text = String(sel.toString() || "").replace(/\s+/g, " ").trim();
      if (!text) { U.toast("请先在 PDF 里选中要标注的文字"); return; }
      const anchor = sel.anchorNode;
      const pageWrap = anchor && anchor.parentElement ? anchor.parentElement.closest(".pdf-canvas-wrap") : null;
      if (!pageWrap) { U.toast("请在 PDF 页面内选中文字"); return; }
      const focusWrap = sel.focusNode && sel.focusNode.parentElement ? sel.focusNode.parentElement.closest(".pdf-canvas-wrap") : null;
      if (!focusWrap || focusWrap !== pageWrap) { U.toast("请在同一页内选中文字"); return; }
      const num = parseInt(pageWrap.dataset.page, 10);
      const entry = this.rendered.get(num);
      if (!entry) return;
      const inner = pageWrap.querySelector(".pdf-page-inner");
      if (!inner) return;
      const innerRect = inner.getBoundingClientRect();
      const viewport = entry.viewport;
      // 收集选中区域的所有碎片矩形（按 span 拆分），再合并成整行高亮条
      const clientRects = [];
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        const rs = range.getClientRects();
        for (let j = 0; j < rs.length; j++) {
          clientRects.push({ left: rs[j].left, top: rs[j].top, right: rs[j].right, bottom: rs[j].bottom });
        }
      }
      const merged = mergeRects(clientRects);
      const rects = [];
      merged.forEach(r => {
        const p1 = viewport.convertToPdfPoint(r.left - innerRect.left, r.top - innerRect.top);
        const p2 = viewport.convertToPdfPoint(r.right - innerRect.left, r.bottom - innerRect.top);
        rects.push([p1[0], p1[1], p2[0], p2[1]]);
      });
      if (!rects.length) { U.toast("未能识别选中区域"); return; }
      const hl = { id: U.uid("hl"), page: num, text, color: "#ffe58f", rects };
      this.page.highlights = this.page.highlights || [];
      this.page.highlights.push(hl);
      global.Store.touch(this.page);
      global.Store.markDirty();
      this.drawHighlights(num);
      sel.removeAllRanges();
      U.toast("已高亮");
    },

    showHighlightMenu(hl, x, y) {
      U.closePopovers();
      const pop = U.el("div", "popover");
      const addItem = (icon, label, fn, danger) => {
        const it = U.el("div", "menu-item" + (danger ? " danger" : ""));
        it.innerHTML = '<span class="mi-ico">' + icon + '</span><span class="mi-label">' + U.esc(label) + '</span>';
        it.addEventListener("click", () => { pop.remove(); fn(); });
        pop.appendChild(it);
      };
      const refs = global.Store.findHighlightRefs(hl.id);
      addItem("🔗", "嵌入到其他页面", () => this.embedHighlight(hl));
      refs.forEach(r => {
        const p = global.Store.getPage(r.pageId);
        addItem("📄", "跳到引用 · " + (p ? (U.segsText(p.title) || "未命名") : "?"), () => this.jumpToRef(r));
      });
      addItem("🗑", "删除高亮", () => this.deleteHighlight(hl), true);
      document.body.appendChild(pop);
      pop.style.left = Math.min(x, window.innerWidth - 220) + "px";
      pop.style.top = y + "px";
      document.addEventListener("mousedown", function h(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); } });
    },

    embedHighlight(hl) {
      if (global.Editor && Editor.openPagePicker) {
        Editor.openPagePicker(target => {
          if (!target) return;
          const blk = global.Store.newBlock("highlight");
          blk.attrs = { highlightId: hl.id, sourcePageId: this.page.id, hlText: hl.text, hlPage: hl.page };
          global.Store.insertBlock(target, blk);
          global.Store.touch(target);
          global.Store.markDirty();
          U.toast("已嵌入到《" + (U.segsText(target.title) || "未命名") + "》");
        });
      }
    },

    jumpToRef(ref) {
      if (global.App) {
        App.openPage(ref.pageId);
        setTimeout(() => {
          const el = document.querySelector('.block[data-block-id="' + ref.blockId + '"]');
          if (el) el.scrollIntoView({ block: "center" });
        }, 250);
      }
    },

    deleteHighlight(hl) {
      this.page.highlights = (this.page.highlights || []).filter(x => x.id !== hl.id);
      global.Store.touch(this.page);
      global.Store.markDirty();
      this.drawHighlights(hl.page);
      U.toast("已删除高亮");
    },

    flashHighlight(id) {
      let tries = 0;
      const check = () => {
        const div = this.pagesEl.querySelector('.pdf-hl[data-highlight-id="' + id + '"]');
        if (div) {
          div.style.boxShadow = "0 0 0 3px var(--accent)";
          setTimeout(() => { div.style.boxShadow = ""; }, 1600);
        } else if (tries < 20) {
          tries++;
          setTimeout(check, 150);
        }
      };
      setTimeout(check, 200);
    },

    /** 提取 PDF 全文文字（供 AI 访问工作区 PDF，返回纯文本，空串表示失败） */
    async extractText(src) {
      src = String(src == null ? "" : src).trim();
      if (!src) return "";
      try {
        const pdfjsLib = await loadPdfjs();
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        const data = /^data:/i.test(src) ? { data: base64ToUint8(src.slice(src.indexOf(",") + 1)) } : { url: src };
        const doc = await pdfjsLib.getDocument(data).promise;
        const parts = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const text = (content.items || []).map(it => it && it.str ? it.str : "").join(" ").trim();
          if (text) parts.push("【第 " + i + " 页】\n" + text);
        }
        return parts.join("\n\n").slice(0, 20000);
      } catch (e) {
        return "";
      }
    },

    /** 把 PDF.js 图片对象数据转成 PNG data URL */
    imageDataToDataUrl(imgObj) {
      try {
        const { data, width, height, kind } = imgObj;
        if (!data || !width || !height) return "";
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        const imageData = ctx.createImageData(width, height);
        const px = imageData.data;
        if (kind === 1) { // 灰度
          for (let i = 0, j = 0; i < data.length; i++, j += 4) {
            const g = data[i];
            px[j] = g; px[j + 1] = g; px[j + 2] = g; px[j + 3] = 255;
          }
        } else if (kind === 2) { // RGB
          for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
            px[j] = data[i]; px[j + 1] = data[i + 1]; px[j + 2] = data[i + 2]; px[j + 3] = 255;
          }
        } else if (kind === 3) { // RGBA
          px.set(data);
        } else {
          return "";
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL("image/png");
      } catch (e) { return ""; }
    },

    /** 提取某页的图片（PDF 用户空间坐标 + PNG data URL） */
    async extractPageImages(pdfPage, num) {
      const images = [];
      try {
        const pdfjsLib = global.pdfjsLib;
        const opList = await pdfPage.getOperatorList();
        const objs = pdfPage.objs;
        for (let i = 0; i < opList.fnArray.length; i++) {
          if (opList.fnArray[i] !== pdfjsLib.OPS.paintImageXObject) continue;
          const args = opList.argsArray[i];
          const objId = args && args[0];
          const tr = args && args[1];
          if (!objId || !Array.isArray(tr)) continue;
          let imgObj = null;
          try { imgObj = objs.get(objId); } catch (e) { imgObj = null; }
          if (!imgObj || !imgObj.data) continue;
          const dataUrl = this.imageDataToDataUrl(imgObj);
          if (!dataUrl) continue;
          const w = Math.abs(tr[0]) || 1;
          const h = Math.abs(tr[3]) || 1;
          images.push({ id: U.uid("img"), page: num, x: tr[4], y: tr[5], w, h, dataUrl });
        }
      } catch (e) { /* 图片提取可选，失败忽略 */ }
      return images;
    },

    /** 渲染某页提取到的图片（点击可管理/嵌入） */
    async drawPageImages(num) {
      const entry = this.rendered.get(num);
      if (!entry || !entry.imgLayer) return;
      let imgs = this._imageCache.get(num);
      if (!imgs) {
        try {
          const pdfPage = await this.doc.getPage(num);
          imgs = await this.extractPageImages(pdfPage, num);
        } catch (e) { imgs = []; }
        this._imageCache.set(num, imgs);
      }
      entry.imgLayer.innerHTML = "";
      const viewport = entry.viewport;
      imgs.forEach(im => {
        const p1 = viewport.convertToViewportPoint(im.x, im.y + im.h);
        const p2 = viewport.convertToViewportPoint(im.x + im.w, im.y);
        const div = U.el("div", "pdf-img");
        div.style.left = Math.min(p1[0], p2[0]) + "px";
        div.style.top = Math.min(p1[1], p2[1]) + "px";
        div.style.width = Math.abs(p2[0] - p1[0]) + "px";
        div.style.height = Math.abs(p2[1] - p1[1]) + "px";
        div.style.backgroundImage = "url(" + im.dataUrl + ")";
        div.style.backgroundSize = "100% 100%";
        div.dataset.imageId = im.id;
        div.title = "点击管理此图片";
        div.addEventListener("click", e => { e.stopPropagation(); this.showImageMenu(im, e.clientX, e.clientY); });
        entry.imgLayer.appendChild(div);
      });
    },

    showImageMenu(img, x, y) {
      U.closePopovers();
      const pop = U.el("div", "popover");
      const addItem = (icon, label, fn, danger) => {
        const it = U.el("div", "menu-item" + (danger ? " danger" : ""));
        it.innerHTML = '<span class="mi-ico">' + icon + '</span><span class="mi-label">' + U.esc(label) + '</span>';
        it.addEventListener("click", () => { pop.remove(); fn(); });
        pop.appendChild(it);
      };
      const refs = global.Store.findImageRefs(img.id);
      addItem("🔗", "嵌入到其他页面", () => this.embedImage(img));
      refs.forEach(r => {
        const p = global.Store.getPage(r.pageId);
        addItem("📄", "跳到引用 · " + (p ? (U.segsText(p.title) || "未命名") : "?"), () => this.jumpToImageRef(r));
      });
      addItem("🗑", "移除图片引用", () => this.deleteImage(img), true);
      document.body.appendChild(pop);
      pop.style.left = Math.min(x, window.innerWidth - 220) + "px";
      pop.style.top = y + "px";
      document.addEventListener("mousedown", function h(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); } });
    },

    embedImage(img) {
      if (global.Editor && Editor.openPagePicker) {
        Editor.openPagePicker(target => {
          if (!target) return;
          // 持久化图片引用
          this.page.images = this.page.images || [];
          if (!this.page.images.some(x => x.id === img.id)) this.page.images.push(img);
          global.Store.touch(this.page);
          global.Store.markDirty();
          const blk = global.Store.newBlock("pdfimage");
          blk.attrs = { imageId: img.id, sourcePageId: this.page.id, imgPage: img.page, imgThumb: img.dataUrl };
          global.Store.insertBlock(target, blk);
          global.Store.touch(target);
          global.Store.markDirty();
          U.toast("已嵌入到《" + (U.segsText(target.title) || "未命名") + "》");
        });
      }
    },

    jumpToImageRef(ref) {
      if (global.App) {
        App.openPage(ref.pageId);
        setTimeout(() => {
          const el = document.querySelector('.block[data-block-id="' + ref.blockId + '"]');
          if (el) el.scrollIntoView({ block: "center" });
        }, 250);
      }
    },

    deleteImage(img) {
      this.page.images = (this.page.images || []).filter(x => x.id !== img.id);
      this._imageCache.delete(img.page);
      global.Store.touch(this.page);
      global.Store.markDirty();
      this.drawPageImages(img.page);
      U.toast("已移除图片引用");
    },

    flashImage(id) {
      let tries = 0;
      const check = () => {
        const div = this.pagesEl.querySelector('.pdf-img[data-image-id="' + id + '"]');
        if (div) {
          div.style.boxShadow = "0 0 0 3px var(--accent)";
          setTimeout(() => { div.style.boxShadow = ""; }, 1600);
        } else if (tries < 20) {
          tries++;
          setTimeout(check, 150);
        }
      };
      setTimeout(check, 200);
    },

    _renderScale() {
      return this._zoomBase != null ? this._zoomBase : this.scale;
    },

    _pageBoxSize(num) {
      const size = this._pageSizes && this._pageSizes[num - 1];
      return {
        width: Math.max(1, Math.round((size ? size.width : 600) * this.scale)),
        height: Math.max(120, Math.round((size ? size.height : 800) * this.scale)) + 25,
      };
    },

    _setPageBox(el, num) {
      const size = this._pageBoxSize(num);
      el.style.width = size.width + "px";
      el.style.height = size.height + "px";
    },

    _applyZoomTransformTo(el) {
      if (this._zoomBase == null) return;
      el.style.transform = "scale(" + (this.scale / this._zoomBase) + ")";
      el.style.transformOrigin = "top center";
    },

    _captureAnchor() {
      const el = this.pagesEl;
      const scrollTop = el.scrollTop;
      let best = null;
      el.querySelectorAll(".pdf-canvas-wrap, .pdf-page-ph").forEach(p => {
        const h = p.offsetHeight;
        if (h <= 0) return;
        const top = this._contentTopOf(p);
        const distance = scrollTop < top ? top - scrollTop : scrollTop > top + h ? scrollTop - top - h : 0;
        if (!best || distance < best.distance) {
          best = { page: parseInt(p.dataset.page, 10) || 1, frac: Math.min(1, Math.max(0, (scrollTop - top) / h)), distance };
        }
      });
      return best || { page: 1, frac: 0 };
    },

    _restoreAnchor(anchor) {
      const target = this.pagesEl.querySelector('[data-page="' + anchor.page + '"]');
      if (!target) return;
      const top = this._contentTopOf(target);
      this.pagesEl.scrollTop = Math.max(0, top + anchor.frac * target.offsetHeight);
    },

    zoomBy(delta) {
      if (!this.pagesEl || !this.doc || !delta) return;
      const prev = this.scale;
      const anchor = this._captureAnchor();
      this.scale = Math.min(4, Math.max(0.6, this.scale + delta));
      if (this.scale === prev) return;
      if (this._zoomBase == null) this._zoomBase = prev;
      this.pagesEl.querySelectorAll(".pdf-canvas-wrap, .pdf-page-ph").forEach(el => this._setPageBox(el, parseInt(el.dataset.page, 10) || 1));
      this.pagesEl.querySelectorAll(".pdf-page-inner").forEach(el => this._applyZoomTransformTo(el));
      this._restoreAnchor(anchor);
      this.updateStatus();
      if (this._zoomTimer) clearTimeout(this._zoomTimer);
      const generation = this._generation;
      this._zoomTimer = setTimeout(() => {
        this._zoomTimer = null;
        if (generation === this._generation) this.commitZoom();
      }, 280);
    },

    _contentTopOf(child) {
      return child.getBoundingClientRect().top - this.pagesEl.getBoundingClientRect().top + this.pagesEl.scrollTop;
    },

    commitZoom() {
      if (this._zoomBase == null || !this.doc) return;
      const anchor = this._captureAnchor();
      this._zoomBase = null;
      this._generation++;
      this.rendered = new Map();
      this.buildSkeleton(this._generation);
      this._restoreAnchor(anchor);
    },

    currentPageFromScroll() {
      if (!this.pagesEl) return this.page.page || 1;
      const mid = this.pagesEl.scrollTop + this.pagesEl.clientHeight / 2;
      let best = this.page.page || 1;
      let bestDist = Infinity;
      this.pagesEl.querySelectorAll(".pdf-page-ph, .pdf-canvas-wrap").forEach(el => {
        const top = this._contentTopOf(el);
        const dist = Math.abs(top - mid);
        if (dist < bestDist) { bestDist = dist; best = parseInt(el.dataset.page, 10) || best; }
      });
      return best;
    },

    scrollToPage(num) {
      const max = this.doc ? this.doc.numPages : 1;
      num = Math.min(max, Math.max(1, parseInt(num, 10) || 1));
      const el = this.pagesEl.querySelector('[data-page="' + num + '"]');
      this.pagesEl.scrollTop = el ? Math.max(0, this._contentTopOf(el)) : 0;
      if (this.pageInputEl) this.pageInputEl.value = num;
      return num;
    },

    updateStatus() {
      if (!this.statusEl) return;
      if (this.doc) this.statusEl.textContent = "共 " + this.doc.numPages + " 页 · 缩放 " + Math.round(this.scale * 100) + "%（Ctrl+滚轮缩放，选中文字后点 🖍 高亮）";
    },

    showFallback(url, err) {
      const frame = U.el("iframe", "web-frame");
      frame.allow = "fullscreen";
      frame.src = url;
      this.pagesEl.appendChild(frame);
      this.statusEl.textContent = "PDF 渲染库不可用（" + (err && err.message ? err.message : "离线") + "），已回退到浏览器内置查看器";
    },
  };

  global.PDFViewer = PDFViewer;
})(window);
