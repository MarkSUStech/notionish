/* ============ MathR: LaTeX rendering (KaTeX via CDN + robust offline fallback) ============ */
(function (global) {
  "use strict";

  const MathR = {
    _loaded: typeof katex !== "undefined",
    _loading: false,
    _waiters: [],

    ensure() {
      if (this._loaded || this._loading) return;
      this._loading = true;
      const base = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min";
      const cssUrls = [
        base + ".css",
        "https://unpkg.com/katex@0.16.11/dist/katex.min.css",
        "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css",
      ];
      const jsUrls = [
        base + ".js",
        "https://unpkg.com/katex@0.16.11/dist/katex.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js",
      ];
      const loadFirst = (list, make, cb) => {
        if (!list.length) { cb(false); return; }
        const el = make(list[0]);
        let settled = false;
        el.onload = () => { if (!settled) { settled = true; cb(true); } };
        el.onerror = () => { if (!settled) { settled = true; loadFirst(list.slice(1), make, cb); } };
        document.head.appendChild(el);
      };
      loadFirst(cssUrls, (u) => {
        const l = document.createElement("link");
        l.rel = "stylesheet";
        l.href = u;
        return l;
      }, (cssOk) => {
        if (!cssOk) { this._loading = false; this._flush(); return; }
        loadFirst(jsUrls, (u) => {
          const s = document.createElement("script");
          s.src = u;
          return s;
        }, () => {
          this._loaded = typeof katex !== "undefined";
          this._loading = false;
          this._flush();
        });
      });
    },

    _flush() {
      const w = this._waiters;
      this._waiters = [];
      w.forEach(fn => { try { fn(); } catch (e) {} });
      if (global.Editor && global.Editor.page) {
        try { Editor.refresh(); } catch (e) {}
      }
    },

    ready(cb) {
      if (this._loaded && typeof katex !== "undefined") { cb(); return; }
      this._waiters.push(cb);
      this.ensure();
    },

    isKaTeX() { return this._loaded && typeof katex !== "undefined"; },

    /** 解码 HTML 实体（&rsquo; &amp; &lt; &gt; &quot; &#NNN; &#xNNN; 等） */
    decodeEntities(s) {
      // 浏览器环境：用 DOM 解码最完整
      try {
        if (document.createElement) {
          const el = document.createElement("span");
          el.innerHTML = s;
          return el.textContent || "";
        }
      } catch (e) {}
      // 回退：正则替换常见实体
      return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&rsquo;/g, "’")
        .replace(/&lsquo;/g, "‘")
        .replace(/&rdquo;/g, "”")
        .replace(/&ldquo;/g, "“")
        .replace(/&ndash;/g, "–")
        .replace(/&mdash;/g, "—")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCharCode(parseInt(d, 10)); } catch (e) { return m; } })
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCharCode(parseInt(h, 16)); } catch (e) { return m; } });
    },

    renderInline(tex) {
      const s = this.decodeEntities(String(tex == null ? "" : tex));
      if (this.isKaTeX()) {
        try { return katex.renderToString(s, { displayMode: false, throwOnError: false }); }
        catch (e) { /* fall through */ }
      }
      return fallbackRender(s);
    },

    renderDisplay(tex) {
      const s = this.decodeEntities(String(tex == null ? "" : tex));
      if (this.isKaTeX()) {
        try { return katex.renderToString(s, { displayMode: true, throwOnError: false }); }
        catch (e) { /* fall through */ }
      }
      return fallbackRender(s);
    },
  };

  /* ---------------- offline fallback renderer (recursive descent) ---------------- */
  const GREEK = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η",
    theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
    rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
    Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", varepsilon: "ε", vartheta: "ϑ",
    varphi: "φ", varrho: "ϱ", varpi: "ϖ", nabla: "∇", partial: "∂",
  };
  const SYMS = {
    cdot: "·", times: "×", pm: "±", mp: "∓", div: "÷", infty: "∞", leq: "≤", geq: "≥",
    neq: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", propto: "∝", forall: "∀",
    exists: "∃", neg: "¬", emptyset: "∅", in: "∈", notin: "∉", subset: "⊂", supset: "⊃",
    subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩", setminus: "∖", rightarrow: "→",
    leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐",
    Leftrightarrow: "⇔", uparrow: "↑", downarrow: "↓", mapsto: "↦", to: "→", gets: "←",
    circ: "∘", bullet: "•", oplus: "⊕", otimes: "⊗", ldots: "…", cdots: "⋯", vdots: "⋮",
    ddots: "⋱", aleph: "ℵ", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ", prime: "′",
    degree: "°", angle: "∠", perp: "⊥", parallel: "∥", surd: "√", triangle: "△",
    square: "□", ast: "∗", mid: "∣", nmid: "∤", le: "≤", ge: "≥", ne: "≠",
    star: "⋆", dagger: "†", ddagger: "‡", wp: "℘", therefore: "∴", because: "∵",
    lnot: "¬", land: "∧", lor: "∨",
  };
  const FUNCS = {
    sin: 1, cos: 1, tan: 1, cot: 1, sec: 1, csc: 1, arcsin: 1, arccos: 1, arctan: 1,
    sinh: 1, cosh: 1, tanh: 1, log: 1, ln: 1, lg: 1, exp: 1, lim: 1, max: 1, min: 1,
    det: 1, dim: 1, gcd: 1, deg: 1, hom: 1, ker: 1, Pr: 1, arg: 1,
  };
  const BIGOP = {
    sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
    bigcup: "⋃", bigcap: "⋂", bigvee: "⋁", bigwedge: "⋀", bigoplus: "⨁",
    bigotimes: "⨂", bigodot: "⨀",
  };
  const ACCENT = {
    hat: "^", bar: "‾", vec: "→", dot: "˙", ddot: "¨", tilde: "~",
    widehat: "^", widetilde: "~", overline: "‾", overrightarrow: "→", check: "ˇ",
  };
  const STYLE = {
    mathbf: "eq-b", textbf: "eq-b", boldsymbol: "eq-b",
    mathrm: "eq-rm", textrm: "eq-rm", textnormal: "eq-rm", operatorname: "eq-rm",
    mathit: "eq-i", textit: "eq-i",
    mathbb: "eq-bb", mathcal: "eq-cal", mathscr: "eq-cal",
    mathsf: "eq-sf", textsf: "eq-sf", mathtt: "eq-tt", texttt: "eq-tt",
  };
  const DELIMS = {
    "(": "(", ")": ")", "[": "[", "]": "]", "|": "|", ".": "", "{": "{", "}": "}",
    "/": "/", langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
    vert: "|", Vert: "‖", uparrow: "↑", downarrow: "↓", updownarrow: "↕",
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fallbackRender(src) {
    return '<span class="eq-fallback">' + parseSeq(String(src || "")) + "</span>";
  }

  function parseSeq(s) {
    let i = 0;
    const n = s.length;
    let out = "";

    function readGroupRaw() {
      i++; // skip {
      let depth = 1, body = "";
      while (i < n && depth > 0) {
        const c = s[i];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
        body += s[i];
        i++;
      }
      return body;
    }

    function readGroup() { return parseSeq(readGroupRaw()); }

    function readBracket() {
      i++; // skip [
      let body = "";
      while (i < n && s[i] !== "]") { body += s[i]; i++; }
      i++;
      return body;
    }

    function readCommand() {
      i++; // skip backslash
      if (i < n && /[a-zA-Z]/.test(s[i])) {
        let name = "";
        while (i < n && /[a-zA-Z]/.test(s[i])) { name += s[i]; i++; }
        return name;
      }
      if (i < n) { const c = s[i]; i++; return c; }
      return "";
    }

    function renderMatrix(env, body) {
      const rows = body.split("\\\\").map(r => r.trim()).filter(r => r.length > 0);
      const brackets = {
        pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"],
        vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], matrix: ["", ""], cases: ["{", ""],
      };
      const b = brackets[env] || ["", ""];
      let h = '<span class="eq-matrix">';
      if (b[0]) h += '<span class="eq-bracket">' + b[0] + "</span>";
      h += '<span class="eq-matrix-cols">';
      rows.forEach(r => {
        h += '<span class="eq-matrix-row">';
        r.split("&").forEach(cell => {
          h += '<span class="eq-matrix-cell">' + parseSeq(cell.trim()) + "</span>";
        });
        h += "</span>";
      });
      h += "</span>";
      if (b[1]) h += '<span class="eq-bracket">' + b[1] + "</span>";
      h += "</span>";
      return h;
    }

    function commandHTML(name) {
      if (GREEK[name]) return GREEK[name];
      if (SYMS[name]) return SYMS[name];

      if (name === "text") {
        return '<span class="eq-text">' + esc(readGroupRaw()) + "</span>";
      }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const a = readGroup(), b = readGroup();
        return '<span class="eq-frac"><span class="eq-num">' + a + '</span><span class="eq-den">' + b + "</span></span>";
      }
      if (name === "binom") {
        const a = readGroup(), b = readGroup();
        return '<span class="eq-binom"><span class="eq-bracket">(</span><span class="eq-stack"><span>' + a + "</span><span>" + b + '</span></span><span class="eq-bracket">)</span></span>';
      }
      if (name === "sqrt") {
        let idx = "";
        if (i < n && s[i] === "[") idx = parseSeq(readBracket());
        const body = readGroup();
        return '<span class="eq-sqrt">' + (idx ? '<span class="eq-sqrt-idx">' + idx + "</span>" : "") + '<span class="eq-sqrt-body">' + body + "</span></span>";
      }
      if (name === "color" || name === "textcolor") {
        const col = readGroupRaw();
        const body = readGroup();
        return '<span style="color:' + esc(col) + '">' + body + "</span>";
      }
      if (BIGOP[name]) {
        let lo = "", hi = "";
        while (i < n && (s[i] === "_" || s[i] === "^")) {
          const which = s[i]; i++;
          let content = "";
          if (i < n && s[i] === "{") content = readGroup();
          else if (i < n) { content = esc(s[i]); i++; }
          if (which === "_") lo = content; else hi = content;
        }
        return '<span class="eq-op"><span class="eq-op-sym">' + BIGOP[name] + "</span>" +
          (lo ? '<span class="eq-lim eq-lo">' + lo + "</span>" : "") +
          (hi ? '<span class="eq-lim eq-hi">' + hi + "</span>" : "") + "</span>";
      }
      if (ACCENT[name]) {
        const body = readGroup();
        return '<span class="eq-accent">' + body + '<span class="eq-mark">' + ACCENT[name] + "</span></span>";
      }
      if (name === "overbrace" || name === "underbrace") {
        const body = readGroup();
        return name === "overbrace"
          ? '<span class="eq-accent">' + body + '<span class="eq-mark">⏞</span></span>'
          : '<span class="eq-accent">' + body + '<span class="eq-mark">⏟</span></span>';
      }
      if (STYLE[name]) {
        const body = readGroup();
        return '<span class="eq-style ' + STYLE[name] + '">' + body + "</span>";
      }
      if (["left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "middle"].indexOf(name) >= 0) {
        if (name === "middle") return '<span class="eq-delim">|</span>';
        let d = "";
        if (i < n) {
          if (s[i] === "\\") { const dn = readCommand(); d = DELIMS[dn] != null ? DELIMS[dn] : esc("\\" + dn); }
          else { d = DELIMS[s[i]] != null ? DELIMS[s[i]] : esc(s[i]); i++; }
        }
        return '<span class="eq-delim">' + d + "</span>";
      }
      if (name === ",") return "&#8202;";
      if (name === ";" || name === ":") return "&#8196;";
      if (name === "quad") return "&#8195;";
      if (name === "qquad") return "&#8195;&#8195;";
      if (name === "!") return "";
      if (name === "space" || name === " ") return " ";
      if (name === "begin") {
        const env = readGroupRaw();
        const endMarker = "\\end{" + env + "}";
        const idx = s.indexOf(endMarker, i);
        let body = "";
        if (idx >= 0) { body = s.slice(i, idx); i = idx + endMarker.length; }
        else { body = s.slice(i); i = n; }
        return renderMatrix(env, body);
      }
      if (FUNCS[name]) return '<span class="eq-fn">' + esc(name) + "</span>";
      return '<span class="eq-cmd">\\' + esc(name) + "</span>";
    }

    function parseAtom() {
      if (i >= n) return null;
      const c = s[i];
      if (c === "}") { i++; return null; }
      let base = "";
      if (c === "{") base = readGroup();
      else if (c === "\\") base = commandHTML(readCommand());
      else {
        i++;
        if (c === "&") base = "";
        else base = esc(c);
      }
      let lo = null, hi = null;
      while (i < n && (s[i] === "^" || s[i] === "_")) {
        const which = s[i]; i++;
        let content = "";
        if (i < n && s[i] === "{") content = readGroup();
        else if (i < n) { content = esc(s[i]); i++; }
        if (which === "^") hi = content; else lo = content;
      }
      if (lo != null) base += "<sub>" + lo + "</sub>";
      if (hi != null) base += "<sup>" + hi + "</sup>";
      return base;
    }

    while (i < n) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; } // math ignores whitespace
      if (c === "%") { while (i < n && s[i] !== "\n") i++; continue; } // comment
      const atom = parseAtom();
      if (atom != null) out += atom;
    }
    return out;
  }

  MathR._fallback = fallbackRender;
  global.MathR = MathR;
})(window);
