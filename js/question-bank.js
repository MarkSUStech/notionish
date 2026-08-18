/* ============ 题库图谱：力导向图 + embedding 语义关联 + 拖拽/缩放/平移 ============ */
(function (global) {
  "use strict";

  /* ---------- 纯函数（可测） ---------- */

  /** 余弦相似度；零向量返回 0 */
  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /** 由向量两两相似度生成边（相似度 ≥ 阈值才连线） */
  function buildEdges(vectors, threshold) {
    const edges = [];
    const t = Number(threshold) || 0.5;
    if (!Array.isArray(vectors)) return edges;
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const s = cosine(vectors[i], vectors[j]);
        if (s >= t) edges.push({ a: i, b: j, score: s });
      }
    }
    return edges;
  }

  /** 圆形分布初始化节点位置 */
  function initPositions(n, width, height) {
    const w = Number(width) || 800, h = Number(height) || 500;
    const count = Math.max(0, n | 0);
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / Math.max(1, count)) * 2 * Math.PI;
      const r = Math.min(w, h) * 0.4;
      return { x: w / 2 + r * Math.cos(angle), y: h / 2 + r * Math.sin(angle), vx: 0, vy: 0 };
    });
  }

  /** 力导向布局一步：斥力 + 弹簧引力 + 向心力 + 阻尼 */
  function layoutStep(nodes, edges, opts) {
    const o = opts || {};
    const repulsion = Number(o.repulsion) || 8000;
    const spring = Number(o.spring) || 0.05;
    const restLen = Number(o.restLen) || 110;
    const centerG = Number(o.centerG) || 0.02;
    const damping = Number(o.damping) || 0.8;
    const w = Number(o.width) || 800, h = Number(o.height) || 500;

    nodes.forEach(n => { if (!n.pinned) { n.fx = 0; n.fy = 0; } });

    // 斥力
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.sin(i * 7 + j) || 0.5; dy = Math.cos(i * 3 + j) || 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = repulsion / d2;
        if (!a.pinned) { a.fx += dx / d * f; a.fy += dy / d * f; }
        if (!b.pinned) { b.fx -= dx / d * f; b.fy -= dy / d * f; }
      }
    }

    // 弹簧引力（边）
    (edges || []).forEach(e => {
      const a = nodes[e.a], b = nodes[e.b];
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const f = (d - restLen) * spring;
      if (!a.pinned) { a.fx += dx / d * f; a.fy += dy / d * f; }
      if (!b.pinned) { b.fx -= dx / d * f; b.fy -= dy / d * f; }
    });

    // 向心力
    nodes.forEach(n => {
      if (n.pinned) return;
      n.fx += (w / 2 - n.x) * centerG;
      n.fy += (h / 2 - n.y) * centerG;
    });

    // 积分 + 边界约束
    nodes.forEach(n => {
      if (n.pinned) return;
      n.vx = (n.vx + n.fx) * damping;
      n.vy = (n.vy + n.fy) * damping;
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 12) n.x = 12; if (n.x > w - 12) n.x = w - 12;
      if (n.y < 12) n.y = 12; if (n.y > h - 12) n.y = h - 12;
    });

    return nodes;
  }

  /** 屏幕坐标 → 世界坐标（纯函数） */
  function screenToWorld(sx, sy, scale, offsetX, offsetY) {
    return { x: (sx - offsetX) / scale, y: (sy - offsetY) / scale };
  }

  /** 以屏幕锚点 (sx,sy) 为中心缩放；返回新 { scale, offsetX, offsetY }（锚点世界坐标不变） */
  function zoomAt(sx, sy, scale, offsetX, offsetY, factor) {
    const MIN = 0.25, MAX = 3;
    const ns = Math.min(MAX, Math.max(MIN, scale * factor));
    const wx = (sx - offsetX) / scale;
    const wy = (sy - offsetY) / scale;
    return { scale: ns, offsetX: sx - wx * ns, offsetY: sy - wy * ns };
  }

  /* ---------- 视图 ---------- */
  const QuestionBank = {
    cosine, buildEdges, initPositions, layoutStep, screenToWorld, zoomAt,

    _questions: [], _nodes: [], _edges: [], _raf: 0,
    _canvas: null, _ctx: null, _status: null,
    _w: 800, _h: 500, _dpr: 1,
    _scale: 1, _offsetX: 0, _offsetY: 0,
    _accent: "#4a7cf7", _text: "#666",

    // 交互状态
    _dragNode: -1, _panning: false, _panStartX: 0, _panStartY: 0,
    _downX: 0, _downY: 0, _moved: false,
    _onMove: null, _onUp: null,

    render() {
      const content = document.getElementById("content");
      content.innerHTML = "";
      const scroll = U.el("div", "page-scroll qbank-scroll");
      content.appendChild(scroll);

      const head = U.el("div", "qbank-head");
      head.appendChild(U.el("div", "qbank-title", U.t("题库图谱")));
      const status = U.el("div", "qbank-status", "");
      head.appendChild(status);
      const layoutBtn = U.el("button", "db-btn", U.icon("layout-grid", { size: 16 }) + " " + U.t("重新布局"));
      layoutBtn.addEventListener("click", () => { this.resetNodes(this._questions); this.runLoop(300); });
      head.appendChild(layoutBtn);
      const refresh = U.el("button", "db-btn", U.icon("refresh-cw", { size: 16 }) + " " + U.t("重算关联"));
      refresh.addEventListener("click", () => this.computeGraph());
      head.appendChild(refresh);
      const hint = U.el("div", "qbank-hint", U.t("拖拽节点移动 · 滚轮缩放 · 拖拽空白平移"));
      head.appendChild(hint);
      scroll.appendChild(head);

      const graphWrap = U.el("div", "qbank-graph");
      const canvas = U.el("canvas", "qbank-canvas");
      graphWrap.appendChild(canvas);
      scroll.appendChild(graphWrap);

      this._canvas = canvas;
      this._status = status;

      const questions = Store.getQuestions();
      this._questions = questions;
      if (!questions.length) {
        graphWrap.appendChild(U.el("div", "qbank-empty", U.t("暂无题目。在页面里用 AI「生成题目」，或插入「题目」块后，这里会显示题目知识图谱。")));
        status.textContent = U.t("0 道题目");
        return;
      }

      this.readColors();
      this.setupCanvas();
      this.resetNodes(questions);
      this.bindEvents(canvas);
      this.computeGraph();
    },

    readColors() {
      try {
        const cs = getComputedStyle(document.documentElement);
        this._accent = cs.getPropertyValue("--accent").trim() || "#4a7cf7";
        this._text = cs.getPropertyValue("--text-sub").trim() || cs.getPropertyValue("--text").trim() || "#666";
      } catch (e) { /* 保持默认色 */ }
    },

    setupCanvas() {
      const canvas = this._canvas;
      const wrap = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth || 800, h = wrap.clientHeight || 500;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      this._ctx = canvas.getContext("2d");
      this._w = w; this._h = h; this._dpr = dpr;
      this._scale = 1; this._offsetX = 0; this._offsetY = 0;
    },

    resetNodes(questions) {
      const pos = initPositions(questions.length, this._w, this._h);
      this._nodes = questions.map((q, i) => ({
        id: q.id,
        label: (q.prompt || "").slice(0, 12) || ("题 " + (i + 1)),
        x: pos[i].x, y: pos[i].y, vx: 0, vy: 0,
      }));
      this._scale = 1; this._offsetX = 0; this._offsetY = 0;
    },

    /* ---------- 交互 ---------- */
    bindEvents(canvas) {
      if (this._onMove) window.removeEventListener("mousemove", this._onMove);
      if (this._onUp) window.removeEventListener("mouseup", this._onUp);
      this._onMove = e => this.onMouseMove(e);
      this._onUp = e => this.onMouseUp(e);
      window.addEventListener("mousemove", this._onMove);
      window.addEventListener("mouseup", this._onUp);
      canvas.addEventListener("mousedown", e => this.onMouseDown(e));
      canvas.addEventListener("wheel", e => this.onWheel(e), { passive: false });
      canvas.addEventListener("click", e => this.onClick(e));
      canvas.style.cursor = "grab";
    },

    toWorld(clientX, clientY) {
      const rect = this._canvas.getBoundingClientRect();
      const sx = clientX - rect.left, sy = clientY - rect.top;
      return screenToWorld(sx, sy, this._scale, this._offsetX, this._offsetY);
    },

    hitNode(wx, wy) {
      const r = 14 / this._scale;
      return this._nodes.findIndex(n => {
        const dx = n.x - wx, dy = n.y - wy;
        return dx * dx + dy * dy <= r * r;
      });
    },

    onMouseDown(e) {
      const p = this.toWorld(e.clientX, e.clientY);
      const idx = this.hitNode(p.x, p.y);
      this._downX = e.clientX; this._downY = e.clientY;
      this._moved = false;
      if (idx >= 0) {
        this._dragNode = idx;
        this._nodes[idx].pinned = true;
        this.runLoop(); // 拖拽中持续运行，邻居被弹簧牵引
        this._canvas.style.cursor = "grabbing";
      } else {
        this._panning = true;
        this._panStartX = e.clientX; this._panStartY = e.clientY;
        this._canvas.style.cursor = "grabbing";
      }
      e.preventDefault();
    },

    onMouseMove(e) {
      const dx = e.clientX - this._downX, dy = e.clientY - this._downY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this._moved = true;
      if (this._dragNode >= 0) {
        const p = this.toWorld(e.clientX, e.clientY);
        const n = this._nodes[this._dragNode];
        n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
        // 不在此处 draw，由 runLoop 每帧绘制（拖拽中持续运行）
      } else if (this._panning) {
        this._offsetX += e.clientX - this._panStartX;
        this._offsetY += e.clientY - this._panStartY;
        this._panStartX = e.clientX; this._panStartY = e.clientY;
        this.draw();
      }
    },

    onMouseUp() {
      if (this._dragNode >= 0) {
        const n = this._nodes[this._dragNode];
        if (n) n.pinned = false;
        this._dragNode = -1;
        this.runLoop(200); // 松手回弹到平衡位置
      }
      this._panning = false;
      if (this._canvas) this._canvas.style.cursor = "grab";
    },

    onWheel(e) {
      e.preventDefault();
      const rect = this._canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const z = zoomAt(sx, sy, this._scale, this._offsetX, this._offsetY, factor);
      this._scale = z.scale; this._offsetX = z.offsetX; this._offsetY = z.offsetY;
      this.draw();
    },

    onClick(e) {
      if (this._moved) return;
      const p = this.toWorld(e.clientX, e.clientY);
      const idx = this.hitNode(p.x, p.y);
      if (idx < 0) return;
      const q = Store.getQuestion(this._nodes[idx].id);
      if (q) this.showQuestion(q);
    },

    /* ---------- 计算与渲染 ---------- */
    async computeGraph() {
      const questions = this._questions;
      const texts = questions.map(q => (q.prompt || "").trim());
      this._status.textContent = U.t("计算关联中…");
      let edges = [];
      try {
        const res = await fetch("/api/questions/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
        if (!Array.isArray(data.vectors)) throw new Error("无向量");
        edges = buildEdges(data.vectors, 0.5);
        this._status.textContent = edges.length + " " + U.t("条关联");
      } catch (e) {
        this._status.textContent = U.t("关联不可用：") + (e && e.message ? e.message : String(e));
      }
      this._edges = edges;
      this.runLoop(300);
    },

    /** 运行力导向循环：拖拽中持续运行（邻居被牵引），否则跑 maxSteps 步后停止 */
    runLoop(maxSteps) {
      if (this._raf) cancelAnimationFrame(this._raf);
      const nodes = this._nodes, edges = this._edges, w = this._w, h = this._h;
      let steps = 0;
      const MAX = maxSteps || 300;
      const loop = () => {
        layoutStep(nodes, edges, { width: w, height: h });
        this.draw();
        steps++;
        if (this._dragNode >= 0) {
          this._raf = requestAnimationFrame(loop); // 拖拽中持续，邻居被牵引
        } else if (steps < MAX) {
          this._raf = requestAnimationFrame(loop);
        } else {
          this._raf = 0;
        }
      };
      this._raf = requestAnimationFrame(loop);
    },

    draw() {
      const ctx = this._ctx, w = this._w, h = this._h, dpr = this._dpr;
      if (!ctx) return;
      // 清屏（屏幕坐标）
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // 视图变换（世界坐标）
      const s = this._scale;
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * this._offsetX, dpr * this._offsetY);

      // 边
      this._edges.forEach(e => {
        const a = this._nodes[e.a], b = this._nodes[e.b];
        if (!a || !b) return;
        const alpha = 0.15 + 0.45 * (e.score || 0);
        ctx.strokeStyle = "rgba(120,120,120," + alpha.toFixed(3) + ")";
        ctx.lineWidth = 1 / s;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      });

      // 节点（拖拽中的节点最后画，置顶）
      const dragIdx = this._dragNode;
      const nodeR = 8;
      const fontPx = 12 / s;
      const drawNode = (n) => {
        ctx.beginPath();
        ctx.arc(n.x, n.y, nodeR, 0, 2 * Math.PI);
        ctx.fillStyle = this._accent;
        ctx.fill();
        ctx.lineWidth = 2 / s;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();
        ctx.font = fontPx + "px sans-serif";
        ctx.fillStyle = this._text;
        ctx.textAlign = "center";
        ctx.fillText(n.label, n.x, n.y - nodeR - 4 / s);
      };
      this._nodes.forEach((n, i) => { if (i !== dragIdx) drawNode(n); });
      if (dragIdx >= 0) drawNode(this._nodes[dragIdx]);
    },

    showQuestion(q) {
      const TYPE = { single: U.t("单选"), multiple: U.t("多选"), judge: U.t("判断"), fill: U.t("填空"), short_answer: U.t("简答") };
      const modal = U.modal({ title: TYPE[q.type] || q.type, size: "sm" });
      modal.el.classList.add("qbank-detail");
      const body = modal.body;

      const prompt = U.el("div", "qbank-prompt");
      prompt.innerHTML = Blocks.qTextHTML(q.prompt);
      body.appendChild(prompt);

      const opts = U.el("div", "qbank-options");
      if (q.type === "judge") {
        opts.appendChild(U.el("span", "qbank-opt" + (q.answer === true ? " correct" : ""), U.t("对")));
        opts.appendChild(U.el("span", "qbank-opt" + (q.answer === false ? " correct" : ""), U.t("错")));
      } else if (q.type === "single" || q.type === "multiple") {
        const ans = Array.isArray(q.answer) ? q.answer : (q.answer == null ? [] : [q.answer]);
        (q.options || []).forEach((opt, i) => opts.appendChild(U.el("span", "qbank-opt" + (ans.includes(i) ? " correct" : ""), Blocks.qTextHTML(opt))));
      } else if (q.type === "fill") {
        const a = Array.isArray(q.answer) ? q.answer.join(" / ") : (q.answer == null ? "" : q.answer);
        opts.appendChild(U.el("span", "qbank-opt qbank-answer", U.t("参考答案：") + Blocks.qTextHTML(a)));
      } else {
        opts.appendChild(U.el("span", "qbank-opt qbank-answer", U.t("参考答案：") + Blocks.qTextHTML(q.answer == null ? "" : q.answer)));
      }
      body.appendChild(opts);

      if (q.explanation) body.appendChild(U.el("div", "qbank-explanation", U.t("解析：") + U.esc(q.explanation)));

      const reveal = U.el("button", "db-btn primary", U.t("显示答案"));
      reveal.addEventListener("click", () => {
        const showing = modal.el.classList.toggle("revealed");
        reveal.textContent = showing ? U.t("隐藏答案") : U.t("显示答案");
      });
      modal.foot.appendChild(reveal);
    },
  };

  global.QuestionBank = QuestionBank;
})(window);
