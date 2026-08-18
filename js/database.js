/* ============ Database: table / board / list / gallery / calendar ============ */
(function (global) {
  "use strict";

  const B = Blocks, S = Store;

  const VIEWS = [
    { id: "table", label: "表格", icon: "⊞" },
    { id: "board", label: "看板", icon: "▤" },
    { id: "list", label: "列表", icon: "☰" },
    { id: "gallery", label: "画廊", icon: "▦" },
    { id: "calendar", label: "日历", icon: "📅" },
    { id: "timeline", label: "时间线", icon: "📈" },
  ];

  const TYPE_LABEL = {
    text: "文本", number: "数字", select: "单选", multi_select: "多选",
    date: "日期", checkbox: "复选框", url: "网址",
    relation: "关联", rollup: "汇总", formula: "公式",
  };

  const Database = {
    page: null,
    root: null,

    /* ================= Main render ================= */
    render(page) {
      this.page = page;
      if (!page.viewState) page.viewState = { view: "table", groupBy: null, calendarProp: null, timelineProp: null, timelineEndProp: null };
      if (!page.viewState.filter) page.viewState.filter = { rules: [] };
      if (!page.viewState.sort) page.viewState.sort = { rules: [] };
      const content = U.renderRoot();
      content.innerHTML = "";
      const scroll = U.el("div", "page-scroll");
      scroll.style.maxWidth = "960px";
      content.appendChild(scroll);

      const head = U.el("div", "page-head");
      const iconEl = U.el("div", "page-icon", page.icon || "🗄");
      iconEl.title = "点击更换图标";
      iconEl.dataset.role = "db-icon";
      head.appendChild(iconEl);
      const title = U.el("div", "db-title");
      title.contentEditable = "true";
      title.spellcheck = false;
      title.dataset.role = "db-title";
      title.dataset.ph = "未命名数据库";
      title.innerHTML = B.segsToHTML(page.title);
      head.appendChild(title);
      scroll.appendChild(head);

      const meta = U.el("div", "page-meta",
        "数据库 · " + page.schema.props.length + " 个属性 · " + S.getChildren(page.id).length + " 条记录 · 更新于 " + U.fmtDate(page.updatedAt));
      scroll.appendChild(meta);

      // view bar
      const bar = U.el("div", "db-view-bar");
      VIEWS.forEach(v => {
        const tab = U.el("button", "db-view-tab" + (page.viewState.view === v.id ? " active" : ""));
        tab.dataset.view = v.id;
        tab.innerHTML = '<span>' + v.icon + '</span><span>' + v.label + '</span>';
        tab.addEventListener("click", () => {
          page.viewState.view = v.id;
          if (v.id === "board" && !page.viewState.groupBy) {
            const sel = page.schema.props.find(p => p.type === "select");
            page.viewState.groupBy = sel ? sel.id : null;
          }
          if (v.id === "calendar" && !page.viewState.calendarProp) {
            const dateProp = page.schema.props.find(p => p.type === "date");
            page.viewState.calendarProp = dateProp ? dateProp.id : null;
          }
          if (v.id === "timeline" && !page.viewState.timelineProp) {
            const dps = page.schema.props.filter(p => p.type === "date");
            page.viewState.timelineProp = dps[0] ? dps[0].id : null;
            page.viewState.timelineEndProp = dps[1] ? dps[1].id : null;
          }
          S.markDirty();
          this.render(page);
        });
        bar.appendChild(tab);
      });
      bar.appendChild(U.el("div", null, ""));
      const newBtn = U.el("button", "db-btn primary", "＋ 新建");
      newBtn.title = "添加一条记录";
      newBtn.dataset.action = "new-row";
      bar.appendChild(newBtn);
      const filterBtn = U.el("button", "db-btn", "⏳ 筛选" + ((page.viewState.filter.rules || []).length ? " (" + page.viewState.filter.rules.length + ")" : ""));
      filterBtn.dataset.action = "filter";
      bar.appendChild(filterBtn);
      const sortBtn = U.el("button", "db-btn", "↕ 排序" + ((page.viewState.sort.rules || []).length ? " (" + page.viewState.sort.rules.length + ")" : ""));
      sortBtn.dataset.action = "sort";
      bar.appendChild(sortBtn);
      const propsBtn = U.el("button", "db-btn", "⚙ 属性");
      propsBtn.dataset.action = "props";
      bar.appendChild(propsBtn);
      scroll.appendChild(bar);

      this.root = U.el("div", "db-root");
      scroll.appendChild(this.root);
      this.renderView();
    },

    renderView() {
      const page = this.page;
      const view = page.viewState.view;
      const fn = {
        table: this.renderTable, board: this.renderBoard, list: this.renderList,
        gallery: this.renderGallery, calendar: this.renderCalendar, timeline: this.renderTimeline,
      }[view];
      if (fn) fn.call(this);
    },

    rows() {
      let list = S.getChildren(this.page.id);
      const fs = this.page.viewState.filter;
      (fs && fs.rules || []).forEach(rule => { list = list.filter(row => this.filterPasses(row, rule)); });
      const ss = this.page.viewState.sort;
      if (ss && ss.rules && ss.rules.length) list = list.slice().sort((a, b) => this.compareRows(a, b));
      return list;
    },

    filterOpsFor(prop) {
      if (!prop) return [];
      const base = [
        { id: "empty", label: "为空" },
        { id: "not_empty", label: "不为空" },
      ];
      switch (prop.type) {
        case "number":
          return [{ id: "eq", label: "=" }, { id: "neq", label: "≠" }, { id: "gt", label: ">" }, { id: "gte", label: "≥" }, { id: "lt", label: "<" }, { id: "lte", label: "≤" }].concat(base);
        case "checkbox":
          return [{ id: "checked", label: "已勾选" }, { id: "unchecked", label: "未勾选" }];
        case "date":
          return [{ id: "is", label: "是" }, { id: "before", label: "早于" }, { id: "after", label: "晚于" }].concat(base);
        case "select":
          return [{ id: "is", label: "是" }, { id: "is_not", label: "不是" }].concat(base);
        case "multi_select":
        case "relation":
          return [{ id: "contains", label: "包含" }, { id: "not_contains", label: "不包含" }].concat(base);
        default:
          return [{ id: "contains", label: "包含" }, { id: "not_contains", label: "不包含" }, { id: "is", label: "等于" }, { id: "is_not", label: "不等于" }].concat(base);
      }
    },

    filterPasses(row, rule) {
      const prop = this.page.schema.props.find(p => p.id === rule.propId);
      if (!prop) return true;
      const v = this.rowValue(row, prop);
      const empty = (x) => x == null || x === "" || (Array.isArray(x) && x.length === 0);
      switch (rule.op) {
        case "empty": return empty(v);
        case "not_empty": return !empty(v);
        case "checked": return !!v;
        case "unchecked": return !v;
        case "eq": return Number(v) === Number(rule.value);
        case "neq": return Number(v) !== Number(rule.value);
        case "gt": return Number(v) > Number(rule.value);
        case "gte": return Number(v) >= Number(rule.value);
        case "lt": return Number(v) < Number(rule.value);
        case "lte": return Number(v) <= Number(rule.value);
        case "is": return String(v) === String(rule.value);
        case "is_not": return String(v) !== String(rule.value);
        case "contains": return Array.isArray(v) ? v.map(String).some(x => x.toLowerCase().includes(String(rule.value).toLowerCase())) : String(v).toLowerCase().includes(String(rule.value).toLowerCase());
        case "not_contains": return Array.isArray(v) ? !v.map(String).some(x => x.toLowerCase().includes(String(rule.value).toLowerCase())) : !String(v).toLowerCase().includes(String(rule.value).toLowerCase());
        case "before": return !!v && !!rule.value && String(v) < String(rule.value);
        case "after": return !!v && !!rule.value && String(v) > String(rule.value);
        default: return true;
      }
    },

    compareRows(a, b) {
      const rules = (this.page.viewState.sort && this.page.viewState.sort.rules) || [];
      for (const r of rules) {
        const prop = this.page.schema.props.find(p => p.id === r.propId);
        if (!prop) continue;
        const va = this.rowValue(a, prop), vb = this.rowValue(b, prop);
        let c = 0;
        if (prop.type === "number") c = (Number(va) || 0) - (Number(vb) || 0);
        else if (prop.type === "checkbox") c = (va ? 1 : 0) - (vb ? 1 : 0);
        else c = String(va).localeCompare(String(vb), "zh");
        if (c !== 0) return r.dir === "desc" ? -c : c;
      }
      return 0;
    },

    rowValue(row, prop) {
      if (prop.type === "formula" || prop.type === "rollup") return S.computedPropValue(this.page, row, prop);
      return S.propValue(this.page, row, prop);
    },

    setRowValue(row, prop, v) {
      S.setPropValue(this.page, row, prop, v);
    },

    /* ================= Table ================= */
    renderTable() {
      const page = this.page;
      const root = this.root;
      U.clear(root);
      const wrap = U.el("div", "db-wrap");
      const table = U.el("table", "db-table");
      const thead = U.el("thead");
      const trH = U.el("tr");
      page.schema.props.forEach(prop => {
        const th = U.el("th");
        th.dataset.prop = prop.id;
        const hc = U.el("div", "db-col-head");
        const nm = U.el("span", "ch-name", U.esc(prop.name) + ' <span class="ch-type">' + TYPE_LABEL[prop.type] + "</span>");
        hc.appendChild(nm);
        th.appendChild(hc);
        trH.appendChild(th);
      });
      const thAdd = U.el("th");
      thAdd.style.width = "44px";
      const addBtn = U.el("button", "db-btn", "＋");
      addBtn.dataset.action = "add-prop";
      thAdd.appendChild(addBtn);
      trH.appendChild(thAdd);
      thead.appendChild(trH);
      table.appendChild(thead);

      const tbody = U.el("tbody");
      this.rows().forEach(row => {
        const tr = U.el("tr");
        tr.dataset.rowId = row.id;
        page.schema.props.forEach(prop => {
          const td = U.el("td");
          td.appendChild(this.cellEl(row, prop));
          tr.appendChild(td);
        });
        const tdDel = U.el("td");
        const del = U.el("button", "icon-btn", U.icon("trash-2", { size: 16 }));
        del.title = "删除记录";
        del.dataset.action = "del-row";
        del.dataset.rowId = row.id;
        tdDel.appendChild(del);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      const newRow = U.el("div", "db-new-row", "＋ 新建记录");
      newRow.dataset.action = "new-row";
      wrap.appendChild(newRow);
      root.appendChild(wrap);
      if (!this.rows().length) {
        const empty = U.el("div", "db-empty", "还没有记录，点击「＋ 新建」添加第一条");
        root.appendChild(empty);
      }
    },

    /* property cell editors */
    cellEl(row, prop) {
      const type = prop.type;
      const wrap = U.el("div", null);
      const v = this.rowValue(row, prop);

      if (type === "text" || type === "url") {
        const inp = U.el("input");
        inp.type = type === "url" ? "url" : "text";
        inp.placeholder = "空";
        inp.value = v || "";
        inp.dataset.rowId = row.id;
        inp.dataset.prop = prop.id;
        inp.dataset.kind = type;
        wrap.appendChild(inp);
        return wrap;
      }
      if (type === "number") {
        const inp = U.el("input");
        inp.type = "number";
        inp.value = v == null ? "" : v;
        inp.dataset.rowId = row.id;
        inp.dataset.prop = prop.id;
        inp.dataset.kind = "number";
        wrap.appendChild(inp);
        return wrap;
      }
      if (type === "date") {
        const inp = U.el("input");
        inp.type = "date";
        inp.value = v || "";
        inp.dataset.rowId = row.id;
        inp.dataset.prop = prop.id;
        inp.dataset.kind = "date";
        wrap.appendChild(inp);
        return wrap;
      }
      if (type === "checkbox") {
        const inp = U.el("input");
        inp.type = "checkbox";
        inp.checked = !!v;
        inp.dataset.rowId = row.id;
        inp.dataset.prop = prop.id;
        inp.dataset.kind = "checkbox";
        wrap.appendChild(inp);
        return wrap;
      }
      if (type === "select") {
        const pill = U.el("span", "pill " + (v ? U.pillColor(v) : "p-gray"), v || "空");
        pill.dataset.rowId = row.id;
        pill.dataset.prop = prop.id;
        pill.dataset.kind = "select";
        wrap.appendChild(pill);
        return wrap;
      }
      if (type === "multi_select") {
        const vals = v || [];
        const holder = U.el("div", null);
        holder.style.display = "flex";
        holder.style.flexWrap = "wrap";
        holder.style.gap = "4px";
        vals.forEach(val => {
          const p = U.el("span", "pill " + U.pillColor(val), val + ' <span class="pill-x">✕</span>');
          p.dataset.rowId = row.id;
          p.dataset.prop = prop.id;
          p.dataset.kind = "multi";
          p.dataset.val = val;
          holder.appendChild(p);
        });
        const addP = U.el("span", "pill p-gray", "＋");
        addP.dataset.rowId = row.id;
        addP.dataset.prop = prop.id;
        addP.dataset.kind = "multi-add";
        holder.appendChild(addP);
        wrap.appendChild(holder);
        return wrap;
      }
      if (type === "relation") {
        const holder = U.el("div", "rel-pills");
        S.relationRows(this.page, row, prop).forEach(r => {
          const p = U.el("span", "pill p-blue", U.esc(U.segsText(r.title) || "未命名") + ' <span class="pill-x">✕</span>');
          p.dataset.rowId = row.id;
          p.dataset.prop = prop.id;
          p.dataset.kind = "rel-remove";
          p.dataset.pageId = r.id;
          p.title = "点击移除关联";
          holder.appendChild(p);
        });
        const addP = U.el("span", "pill p-gray", "＋ 添加");
        addP.dataset.rowId = row.id;
        addP.dataset.prop = prop.id;
        addP.dataset.kind = "rel-add";
        holder.appendChild(addP);
        wrap.appendChild(holder);
        return wrap;
      }
      if (type === "formula" || type === "rollup") {
        const val = this.rowValue(row, prop);
        const txt = val == null ? "" : (typeof val === "boolean" ? (val ? "✓" : "") : (Array.isArray(val) ? val.join(", ") : String(val)));
        const el = U.el("div", "cell-static" + (txt === "" ? " empty" : ""), txt || "—");
        el.title = type === "formula" ? "公式属性（只读）" : "汇总属性（只读）";
        wrap.appendChild(el);
        return wrap;
      }
      return wrap;
    },

    /* ================= Board ================= */
    renderBoard() {
      const page = this.page;
      const root = this.root;
      U.clear(root);
      const groupProp = page.schema.props.find(p => p.id === page.viewState.groupBy) ||
        page.schema.props.find(p => p.type === "select");
      if (!groupProp) {
        const empty = U.el("div", "db-empty", "看板视图需要一个「单选」属性来分组。请先在「属性」中添加一个单选属性。");
        root.appendChild(empty);
        return;
      }
      page.viewState.groupBy = groupProp.id;
      const options = groupProp.options || [];
      const board = U.el("div", "db-board");
      const groups = options.map(o => ({ value: o, rows: [] }));
      groups.push({ value: null, rows: [] }); // 未分组
      this.rows().forEach(row => {
        const v = this.rowValue(row, groupProp);
        const g = groups.find(g => (g.value == null ? (v == null || v === "") : g.value === v));
        (g || groups[groups.length - 1]).rows.push(row);
      });
      groups.forEach(g => {
        const col = U.el("div", "board-col");
        col.dataset.group = g.value == null ? "__none__" : g.value;
        col.dataset.prop = groupProp.id;
        const head = U.el("div", "board-col-head");
        const pill = U.el("span", "pill " + (g.value ? U.pillColor(g.value) : "p-gray"), g.value || "未分组");
        const cnt = U.el("span", "bc-count", String(g.rows.length));
        head.appendChild(pill); head.appendChild(cnt);
        col.appendChild(head);
        g.rows.forEach(row => {
          const card = U.el("div", "board-card");
          card.draggable = true;
          card.dataset.rowId = row.id;
          const cover = this.rowCover(row);
          if (cover) {
            const img = U.el("img", "bc-cover");
            img.src = cover;
            card.appendChild(img);
          }
          const t = U.el("div", "bc-title");
          t.innerHTML = (row.icon ? '<span>' + U.esc(row.icon) + "</span>" : "") + '<span>' + U.esc(U.segsText(row.title) || "未命名") + "</span>";
          card.appendChild(t);
          const pills = U.el("div", "bc-pills");
          page.schema.props.forEach(p => {
            if (p.id === groupProp.id) return;
            const v = this.rowValue(row, p);
            if (p.type === "select" && v) pills.appendChild(U.el("span", "pill " + U.pillColor(v), U.esc(v)));
            else if (p.type === "multi_select" && v && v.length) v.forEach(x => pills.appendChild(U.el("span", "pill " + U.pillColor(x), U.esc(x))));
            else if (p.type === "checkbox" && v) pills.appendChild(U.el("span", "pill p-green", "✓"));
            else if (p.type === "number" && v != null && v !== "") pills.appendChild(U.el("span", "pill p-gray", U.esc(String(v))));
            else if (p.type === "relation") S.relationRows(this.page, row, p).slice(0, 3).forEach(x => pills.appendChild(U.el("span", "pill p-blue", U.esc(U.segsText(x.title) || "未命名"))));
            else if (p.type === "formula" || p.type === "rollup") { if (v != null && v !== "" && v !== "—") pills.appendChild(U.el("span", "pill p-gray", U.esc(String(v)))); }
          });
          if (pills.children.length) card.appendChild(pills);
          card.addEventListener("click", (e) => {
            if (e.target.closest("[data-row-id]") === card && !card.classList.contains("dragging")) {
              if (global.App) App.openPage(row.id);
            }
          });
          card.addEventListener("dragstart", (e) => {
            card.classList.add("dragging");
            e.dataTransfer.setData("text/plain", row.id);
            e.stopPropagation();
          });
          card.addEventListener("dragend", () => card.classList.remove("dragging"));
          col.appendChild(card);
        });
        const add = U.el("div", "bc-add", "＋ 添加");
        add.dataset.group = g.value == null ? "__none__" : g.value;
        add.dataset.prop = groupProp.id;
        add.dataset.action = "board-add";
        col.appendChild(add);
        board.appendChild(col);
      });
      // add group column
      const addCol = U.el("div", "board-col");
      const addBtn = U.el("div", "bc-add", "＋ 添加分组");
      addBtn.dataset.action = "board-add-group";
      addBtn.dataset.prop = groupProp.id;
      addCol.appendChild(addBtn);
      board.appendChild(addCol);

      root.appendChild(board);
    },

    /* ================= List ================= */
    renderList() {
      const page = this.page;
      const root = this.root;
      U.clear(root);
      const list = U.el("div", "db-list");
      this.rows().forEach(row => {
        const r = U.el("div", "list-row");
        r.dataset.rowId = row.id;
        const t = U.el("span", "lr-title");
        t.innerHTML = (row.icon ? '<span>' + U.esc(row.icon) + "</span>" : "") + '<span>' + U.esc(U.segsText(row.title) || "未命名") + "</span>";
        const preview = U.el("span", "lr-preview");
        preview.textContent = U.preview(row.children && row.children[0] && row.children[0].text ? row.children[0].text : [], 60);
        const pills = U.el("span", "lr-pills");
        page.schema.props.forEach(p => {
          const v = this.rowValue(row, p);
          if (p.type === "select" && v) pills.appendChild(U.el("span", "pill " + U.pillColor(v), U.esc(v)));
          else if (p.type === "multi_select" && v && v.length) v.slice(0, 3).forEach(x => pills.appendChild(U.el("span", "pill " + U.pillColor(x), U.esc(x))));
          else if (p.type === "date" && v) pills.appendChild(U.el("span", "pill p-gray", "📅 " + U.esc(v)));
          else if (p.type === "relation") S.relationRows(this.page, row, p).slice(0, 3).forEach(x => pills.appendChild(U.el("span", "pill p-blue", U.esc(U.segsText(x.title) || "未命名"))));
          else if (p.type === "formula" || p.type === "rollup") { if (v != null && v !== "" && v !== "—") pills.appendChild(U.el("span", "pill p-gray", U.esc(String(v)))); }
        });
        r.appendChild(t); r.appendChild(preview); r.appendChild(pills);
        r.addEventListener("click", () => { if (global.App) App.openPage(row.id); });
        list.appendChild(r);
      });
      if (!this.rows().length) list.appendChild(U.el("div", "db-empty", "还没有记录"));
      root.appendChild(list);
      const newRow = U.el("div", "db-new-row", "＋ 新建记录");
      newRow.dataset.action = "new-row";
      root.appendChild(newRow);
    },

    /* ================= Gallery ================= */
    renderGallery() {
      const page = this.page;
      const root = this.root;
      U.clear(root);
      const grid = U.el("div", "db-gallery");
      this.rows().forEach(row => {
        const card = U.el("div", "gal-card");
        card.dataset.rowId = row.id;
        const cover = this.rowCover(row);
        if (cover) {
          const img = U.el("img", "g-cover");
          img.src = cover;
          card.appendChild(img);
        } else {
          const empty = U.el("div", "g-cover-empty", row.icon || "📄");
          card.appendChild(empty);
        }
        const body = U.el("div", "g-body");
        const t = U.el("div", "g-title");
        t.innerHTML = '<span>' + U.esc(U.segsText(row.title) || "未命名") + "</span>";
        body.appendChild(t);
        const pills = U.el("div", "g-pills");
        page.schema.props.forEach(p => {
          const v = this.rowValue(row, p);
          if (p.type === "select" && v) pills.appendChild(U.el("span", "pill " + U.pillColor(v), U.esc(v)));
          else if (p.type === "multi_select" && v && v.length) v.slice(0, 2).forEach(x => pills.appendChild(U.el("span", "pill " + U.pillColor(x), U.esc(x))));
          else if (p.type === "relation") S.relationRows(this.page, row, p).slice(0, 2).forEach(x => pills.appendChild(U.el("span", "pill p-blue", U.esc(U.segsText(x.title) || "未命名"))));
          else if (p.type === "formula" || p.type === "rollup") { if (v != null && v !== "" && v !== "—") pills.appendChild(U.el("span", "pill p-gray", U.esc(String(v)))); }
        });
        if (pills.children.length) body.appendChild(pills);
        card.appendChild(body);
        card.addEventListener("click", () => { if (global.App) App.openPage(row.id); });
        grid.appendChild(card);
      });
      const newCard = U.el("div", "gal-card");
      const gNew = U.el("div", "g-new", "＋ 新建记录");
      gNew.dataset.action = "new-row";
      newCard.appendChild(gNew);
      grid.appendChild(newCard);
      root.appendChild(grid);
    },

    /* ================= Calendar ================= */
    renderCalendar() {
      const page = this.page;
      const root = this.root;
      U.clear(root);
      const dateProp = page.schema.props.find(p => p.id === page.viewState.calendarProp) ||
        page.schema.props.find(p => p.type === "date");
      if (!dateProp) {
        const empty = U.el("div", "db-empty", "日历视图需要一个「日期」属性。请先在「属性」中添加日期属性。");
        root.appendChild(empty);
        return;
      }
      page.viewState.calendarProp = dateProp.id;
      const now = this._calDate || new Date();
      const year = now.getFullYear(), month = now.getMonth();

      const head = U.el("div", "db-cal-head");
      const prev = U.el("button", "db-btn", "‹");
      const next = U.el("button", "db-btn", "›");
      const label = U.el("span", null, year + " 年 " + (month + 1) + " 月");
      head.appendChild(prev);
      head.appendChild(label);
      head.appendChild(next);
      root.appendChild(head);

      const grid = U.el("div", "cal-grid");
      ["日", "一", "二", "三", "四", "五", "六"].forEach(d => {
        grid.appendChild(U.el("div", "cal-dow", d));
      });
      const firstDay = new Date(year, month, 1);
      const startOffset = firstDay.getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const itemsByDate = {};
      this.rows().forEach(row => {
        const v = this.rowValue(row, dateProp);
        if (v) {
          if (!itemsByDate[v]) itemsByDate[v] = [];
          itemsByDate[v].push(row);
        }
      });
      const todayStr = (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();

      for (let i = 0; i < startOffset; i++) {
        const blank = U.el("div", "cal-day out");
        grid.appendChild(blank);
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
        const day = U.el("div", "cal-day" + (ds === todayStr ? " today" : ""));
        day.dataset.date = ds;
        const num = U.el("div", "cal-num", String(d));
        day.appendChild(num);
        const items = U.el("div", "cal-items");
        (itemsByDate[ds] || []).slice(0, 4).forEach(row => {
          const it = U.el("div", "cal-item", U.esc(U.segsText(row.title) || "未命名"));
          it.title = U.segsText(row.title) || "未命名";
          it.addEventListener("click", (e) => {
            e.stopPropagation();
            if (global.App) App.openPage(row.id);
          });
          items.appendChild(it);
        });
        if ((itemsByDate[ds] || []).length > 4) items.appendChild(U.el("div", "cal-item", "＋" + ((itemsByDate[ds].length - 4)) + " 更多"));
        day.appendChild(items);
        day.addEventListener("click", () => {
          const row = S.createRow(page, "未命名");
          this.setRowValue(row, dateProp, ds);
          if (global.App) App.openPage(row.id);
        });
        grid.appendChild(day);
      }
      const fill = 7 - ((startOffset + daysInMonth) % 7 || 7);
      for (let i = 0; i < fill; i++) grid.appendChild(U.el("div", "cal-day out"));
      root.appendChild(grid);

      prev.addEventListener("click", () => { this._calDate = new Date(year, month - 1, 1); this.render(page); });
      next.addEventListener("click", () => { this._calDate = new Date(year, month + 1, 1); this.render(page); });
    },

    /* ================= Timeline ================= */
    _parseDate(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
      if (!m) return null;
      return new Date(+m[1], +m[2] - 1, +m[3]);
    },
    _addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; },

    renderTimeline() {
      const page = this.page;
      const root = this.root;
      U.clear(root);
      const startProp = page.schema.props.find(p => p.id === page.viewState.timelineProp) || page.schema.props.find(p => p.type === "date");
      if (!startProp) {
        root.appendChild(U.el("div", "db-empty", "时间线视图需要一个「日期」属性作为开始日期。请先在「属性」中添加日期属性。"));
        return;
      }
      page.viewState.timelineProp = startProp.id;
      const endProp = page.schema.props.find(p => p.id === page.viewState.timelineEndProp) || null;
      const rows = this.rows();

      const today = new Date(); today.setHours(0, 0, 0, 0);
      let min = null, max = null;
      rows.forEach(row => {
        const s = this._parseDate(this.rowValue(row, startProp));
        if (s) { if (!min || s < min) min = s; if (!max || s > max) max = s; }
        if (endProp) {
          const e = this._parseDate(this.rowValue(row, endProp));
          if (e) { if (!min || e < min) min = e; if (!max || e > max) max = e; }
        }
      });
      if (!min) { min = this._addDays(today, -7); max = this._addDays(today, 21); }
      else { min = this._addDays(min, -3); max = this._addDays(max, 3); }
      while ((max - min) / 86400000 < 29) max = this._addDays(max, 7);

      const DAY_W = 36, LEFT_W = 220;
      const days = [];
      for (let d = new Date(min); d <= max; d = this._addDays(d, 1)) days.push(new Date(d));
      const totalW = days.length * DAY_W;
      const headW = LEFT_W + totalW;

      const bar = U.el("div", "db-view-bar");
      const label = U.el("div", "tl-label", startProp.name + (endProp ? " → " + endProp.name : "（单日）"));
      bar.appendChild(label);
      const gear = U.el("button", "db-btn", "⚙ 时间线");
      gear.addEventListener("click", () => this.openTimelineConfig(startProp, endProp));
      bar.appendChild(gear);
      root.appendChild(bar);

      const sc = U.el("div", "tl-scroll");
      const head = U.el("div", "tl-head");
      head.style.width = headW + "px";
      head.appendChild(U.el("div", "tl-corner", "记录"));
      const headDays = U.el("div", "tl-head-days");
      headDays.style.width = totalW + "px";
      // month strip
      const monthCells = [];
      { let curKey = null, curLabel = "", count = 0;
        days.forEach(d => {
          const key = d.getFullYear() + "-" + d.getMonth();
          if (curKey !== key) {
            if (curKey != null) monthCells.push({ label: curLabel, count });
            curKey = key; curLabel = I18n.lang === "en" ? (d.getFullYear() + "/" + (d.getMonth() + 1)) : (d.getFullYear() + "年" + (d.getMonth() + 1) + "月"); count = 0;
          }
          count++;
        });
        if (curKey != null) monthCells.push({ label: curLabel, count });
      }
      const months = U.el("div", "tl-months");
      monthCells.forEach(mc => { const c = U.el("div", "tl-month", mc.label); c.style.width = (mc.count * DAY_W) + "px"; months.appendChild(c); });
      headDays.appendChild(months);
      const dayStrip = U.el("div", "tl-days");
      days.forEach(d => {
        const c = U.el("div", "tl-day" + (d.getDay() === 0 || d.getDay() === 6 ? " wk" : ""), String(d.getDate()));
        c.style.width = DAY_W + "px";
        dayStrip.appendChild(c);
      });
      headDays.appendChild(dayStrip);
      head.appendChild(headDays);
      sc.appendChild(head);

      rows.forEach(row => {
        const r = U.el("div", "tl-row");
        r.style.width = headW + "px";
        const t = U.el("div", "tl-title", (row.icon ? U.esc(row.icon) + " " : "") + U.esc(U.segsText(row.title) || "未命名"));
        t.addEventListener("click", () => { if (global.App) App.openPage(row.id); });
        r.appendChild(t);
        const lane = U.el("div", "tl-lane");
        lane.style.width = totalW + "px";
        const s = this._parseDate(this.rowValue(row, startProp));
        if (s) {
          let e = s;
          if (endProp) { const ev = this._parseDate(this.rowValue(row, endProp)); if (ev && ev >= s) e = ev; }
          const off = Math.max(0, Math.round((s - min) / 86400000));
          const span = Math.max(1, Math.round((e - s) / 86400000) + 1);
          const b = U.el("div", "tl-bar", U.esc(U.segsText(row.title) || "未命名"));
          b.style.left = (off * DAY_W + 2) + "px";
          b.style.width = (span * DAY_W - 4) + "px";
          b.title = U.segsText(row.title) || "未命名";
          b.addEventListener("click", (ev) => { ev.stopPropagation(); if (global.App) App.openPage(row.id); });
          lane.appendChild(b);
        }
        r.appendChild(lane);
        sc.appendChild(r);
      });
      root.appendChild(sc);
      if (!rows.length) root.appendChild(U.el("div", "db-empty", "还没有记录"));
    },

    openTimelineConfig(startProp, endProp) {
      const page = this.page;
      U.closePopovers();
      const pop = U.el("div", "popover");
      pop.style.padding = "10px 14px";
      const dateProps = page.schema.props.filter(p => p.type === "date");
      const mk = (label) => { const l = U.el("div", null, label); l.style.cssText = "font-size:12px;color:var(--text-sub);margin:6px 0 2px"; pop.appendChild(l); };
      mk("开始日期属性");
      const selStart = U.el("select", "modal-input"); selStart.style.width = "180px";
      dateProps.forEach(p => { const o = U.el("option", null, p.name); o.value = p.id; if (p.id === (startProp && startProp.id)) o.selected = true; selStart.appendChild(o); });
      pop.appendChild(selStart);
      mk("结束日期属性");
      const selEnd = U.el("select", "modal-input"); selEnd.style.width = "180px";
      const e0 = U.el("option", null, "（无，单日）"); e0.value = ""; selEnd.appendChild(e0);
      dateProps.forEach(p => { const o = U.el("option", null, p.name); o.value = p.id; if (p.id === (endProp && endProp.id)) o.selected = true; selEnd.appendChild(o); });
      pop.appendChild(selEnd);
      const apply = U.el("button", "db-btn primary", "应用"); apply.style.marginTop = "10px";
      apply.addEventListener("click", () => {
        page.viewState.timelineProp = selStart.value || null;
        page.viewState.timelineEndProp = selEnd.value || null;
        S.markDirty();
        pop.remove();
        this.render(page);
      });
      pop.appendChild(apply);
      document.body.appendChild(pop);
      const rect = this.root.getBoundingClientRect();
      U.placePop(pop, rect, {});
      document.addEventListener("mousedown", function h(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
      });
    },

    rowCover(row) {
      // find first image block or cover
      if (row.cover) return row.cover;
      const walk = (blocks) => {
        for (const b of blocks || []) {
          if (b.type === "image" && b.attrs.src) return b.attrs.src;
          const r = walk(b.children);
          if (r) return r;
        }
        return null;
      };
      return walk(row.children);
    },

    /* ================= Interactions ================= */
    bind(root) {
      root.addEventListener("input", (e) => this.onInput(e));
      root.addEventListener("change", (e) => this.onChange(e));
      root.addEventListener("click", (e) => this.onClick(e));
      root.addEventListener("keydown", (e) => {
        const t = e.target;
        if (t && t.dataset && t.dataset.role === "db-title" && e.key === "Enter") {
          e.preventDefault();
          t.blur();
        }
      });
      root.addEventListener("dragover", (e) => this.onDragOver(e));
      root.addEventListener("drop", (e) => this.onDrop(e));
      root.addEventListener("dragend", () => {
        document.querySelectorAll(".board-card.dragging").forEach(c => c.classList.remove("dragging"));
        document.querySelectorAll(".board-col.drop-over").forEach(c => c.classList.remove("drop-over"));
      });
    },

    onInput(e) {
      const t = e.target;
      const page = this.page;
      if (!page) return;
      if (t.dataset && t.dataset.role === "db-title") {
        page.title = B.htmlToSegments(t);
        S.touch(page); S.markDirty();
        return;
      }
      // text/url/number cell typing
      if (t.dataset && t.dataset.kind && (t.dataset.kind === "text" || t.dataset.kind === "url" || t.dataset.kind === "number")) {
        const row = S.getPage(t.dataset.rowId);
        if (!row) return;
        const prop = page.schema.props.find(p => p.id === t.dataset.prop);
        if (!prop) return;
        const v = t.dataset.kind === "number" ? (t.value === "" ? null : Number(t.value)) : t.value;
        this.setRowValue(row, prop, v);
      }
    },

    onChange(e) {
      const t = e.target;
      const page = this.page;
      if (!page) return;
      if (t.dataset && t.dataset.kind === "date") {
        const row = S.getPage(t.dataset.rowId);
        if (!row) return;
        const prop = page.schema.props.find(p => p.id === t.dataset.prop);
        if (prop) this.setRowValue(row, prop, t.value);
      } else if (t.dataset && t.dataset.kind === "checkbox") {
        const row = S.getPage(t.dataset.rowId);
        if (!row) return;
        const prop = page.schema.props.find(p => p.id === t.dataset.prop);
        if (prop) this.setRowValue(row, prop, t.checked);
      }
    },

    async onClick(e) {
      const t = e.target;
      const page = this.page;
      if (!page) return;

      if (t.dataset && t.dataset.role === "db-icon") {
        Editor.openEmojiPicker((emoji) => {
          page.icon = emoji;
          S.markDirty();
          this.render(page);
        });
        return;
      }

      const action = t.dataset && t.dataset.action;
      if (action === "new-row") {
        const row = S.createRow(page);
        this.render(page);
        if (global.App) App.openPage(row.id);
        return;
      }
      if (action === "add-prop") {
        this.openPropDialog(null);
        return;
      }
      if (action === "props") {
        this.openPropManager();
        return;
      }
      if (action === "filter") {
        this.openFilterModal();
        return;
      }
      if (action === "sort") {
        this.openSortModal();
        return;
      }
      if (action === "del-row") {
        const rowId = t.dataset.rowId;
        const ok = await U.confirmModal({ title: "删除记录", message: "确定删除这条记录吗？", okText: "删除", danger: true });
        if (ok) {
          S.deletePage(rowId, false);
          this.render(page);
        }
        return;
      }
      if (action === "board-add-group") {
        const prop = page.schema.props.find(p => p.id === t.dataset.prop);
        if (!prop) return;
        const name = await U.promptModal({ title: "新分组", placeholder: "分组名称" });
        if (name && name.trim()) {
          prop.options = prop.options || [];
          prop.options.push(name.trim());
          S.markDirty();
          this.render(page);
        }
        return;
      }
      if (action === "board-add") {
        const group = t.dataset.group;
        const prop = page.schema.props.find(p => p.id === t.dataset.prop);
        const row = S.createRow(page);
        if (group !== "__none__" && prop) this.setRowValue(row, prop, group);
        this.render(page);
        if (global.App) App.openPage(row.id);
        return;
      }

      // column header → prop manager focused on prop
      const th = t.closest("th[data-prop]");
      if (th && t.closest(".db-table")) {
        this.openPropManager(th.dataset.prop);
        return;
      }

      // select pill → options popover
      if (t.dataset && t.dataset.kind === "select") {
        this.openSelectMenu(t, t.dataset.rowId, t.dataset.prop);
        return;
      }
      // multi-select pill remove
      if (t.dataset && t.dataset.kind === "multi") {
        const row = S.getPage(t.dataset.rowId);
        const prop = page.schema.props.find(p => p.id === t.dataset.prop);
        if (row && prop) {
          const vals = this.rowValue(row, prop).filter(x => x !== t.dataset.val);
          this.setRowValue(row, prop, vals);
          this.render(page);
        }
        return;
      }
      if (t.dataset && t.dataset.kind === "multi-add") {
        this.openMultiMenu(t, t.dataset.rowId, t.dataset.prop);
        return;
      }
      if (t.dataset && t.dataset.kind === "rel-remove") {
        const row = S.getPage(t.dataset.rowId);
        const prop = page.schema.props.find(p => p.id === t.dataset.prop);
        if (row && prop) {
          row.props[prop.id] = (row.props[prop.id] || []).filter(x => x !== t.dataset.pageId);
          this.setRowValue(row, prop, row.props[prop.id]);
          this.render(page);
        }
        return;
      }
      if (t.dataset && t.dataset.kind === "rel-add") {
        this.openRelationPicker(t, t.dataset.rowId, t.dataset.prop);
        return;
      }
    },

    /* relation picker: toggle related rows from the target database */
    openRelationPicker(anchor, rowId, propId) {
      const page = this.page;
      const row = S.getPage(rowId);
      const prop = page.schema.props.find(p => p.id === propId);
      if (!row || !prop) return;
      const targetDb = S.relationTargetPage(prop);
      if (!targetDb) { U.toast("请先在「属性」中为「" + prop.name + "」选择关联的数据库"); return; }
      U.closePopovers();
      const pop = U.el("div", "popover");
      const scroll = U.el("div", "menu-scroll");
      pop.appendChild(scroll);
      const cur = Array.isArray(row.props[prop.id]) ? row.props[prop.id] : [];
      const rows = S.getChildren(targetDb.id);
      if (!rows.length) {
        const empty = U.el("div", "menu-item");
        empty.innerHTML = '<span class="mi-label">目标数据库暂无记录</span>';
        scroll.appendChild(empty);
      }
      rows.forEach(r => {
        const on = cur.includes(r.id);
        const it = U.el("div", "menu-item" + (on ? " sel" : ""));
        it.innerHTML = '<span class="mi-ico">' + U.esc(r.icon || "📄") + '</span><span class="mi-label">' + U.esc(U.segsText(r.title) || "未命名") + '</span><span class="mi-ico">' + (on ? "✓" : "") + "</span>";
        it.addEventListener("click", () => {
          const next = on ? cur.filter(x => x !== r.id) : cur.concat(r.id);
          row.props[prop.id] = next;
          this.setRowValue(row, prop, next);
          pop.remove();
          this.render(page);
        });
        scroll.appendChild(it);
      });
      const rect = anchor.getBoundingClientRect();
      U.placePop(pop, rect, {});
      document.addEventListener("mousedown", function h(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
      });
    },

    /* select dropdown */
    openSelectMenu(anchor, rowId, propId) {
      const page = this.page;
      const row = S.getPage(rowId);
      const prop = page.schema.props.find(p => p.id === propId);
      if (!row || !prop) return;
      U.closePopovers();
      const pop = U.el("div", "popover");
      const scroll = U.el("div", "menu-scroll");
      pop.appendChild(scroll);
      (prop.options || []).forEach(o => {
        const it = U.el("div", "menu-item" + (this.rowValue(row, prop) === o ? " sel" : ""));
        it.innerHTML = '<span class="pill ' + U.pillColor(o) + '">' + U.esc(o) + "</span>";
        it.addEventListener("click", () => {
          this.setRowValue(row, prop, o);
          pop.remove();
          this.render(page);
        });
        scroll.appendChild(it);
      });
      const clear = U.el("div", "menu-item");
      clear.innerHTML = '<span class="mi-ico">∅</span><span class="mi-label">清除</span>';
      clear.addEventListener("click", () => {
        this.setRowValue(row, prop, "");
        pop.remove();
        this.render(page);
      });
      scroll.appendChild(clear);
      scroll.appendChild(U.el("div", "menu-sep"));
      const add = U.el("div", "menu-item");
      add.innerHTML = '<span class="mi-ico">＋</span><span class="mi-label">添加选项…</span>';
      add.addEventListener("click", async () => {
        pop.remove();
        const name = await U.promptModal({ title: "添加选项", placeholder: "选项名称" });
        if (name && name.trim()) {
          prop.options = prop.options || [];
          prop.options.push(name.trim());
          this.setRowValue(row, prop, name.trim());
          S.markDirty();
          this.render(page);
        }
      });
      scroll.appendChild(add);
      const rect = anchor.getBoundingClientRect();
      U.placePop(pop, rect, {});
      document.addEventListener("mousedown", function h(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
      });
    },

    openMultiMenu(anchor, rowId, propId) {
      const page = this.page;
      const row = S.getPage(rowId);
      const prop = page.schema.props.find(p => p.id === propId);
      if (!row || !prop) return;
      U.closePopovers();
      const pop = U.el("div", "popover");
      const scroll = U.el("div", "menu-scroll");
      pop.appendChild(scroll);
      const cur = this.rowValue(row, prop);
      (prop.options || []).forEach(o => {
        const on = cur.includes(o);
        const it = U.el("div", "menu-item" + (on ? " sel" : ""));
        it.innerHTML = '<span class="pill ' + U.pillColor(o) + '">' + U.esc(o) + "</span>";
        it.addEventListener("click", () => {
          const vals = on ? cur.filter(x => x !== o) : cur.concat(o);
          this.setRowValue(row, prop, vals);
          pop.remove();
          this.render(page);
        });
        scroll.appendChild(it);
      });
      const add = U.el("div", "menu-item");
      add.innerHTML = '<span class="mi-ico">＋</span><span class="mi-label">添加选项…</span>';
      add.addEventListener("click", async () => {
        pop.remove();
        const name = await U.promptModal({ title: "添加选项", placeholder: "选项名称" });
        if (name && name.trim()) {
          prop.options = prop.options || [];
          prop.options.push(name.trim());
          S.markDirty();
          this.render(page);
        }
      });
      scroll.appendChild(add);
      const rect = anchor.getBoundingClientRect();
      U.placePop(pop, rect, {});
      document.addEventListener("mousedown", function h(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
      });
    },

    /* property manager modal */
    openPropManager(focusPropId) {
      const page = this.page;
      const modal = U.modal({ title: "数据库属性" });
      const list = U.el("div", null);
      modal.body.appendChild(list);
      const render = () => {
        U.clear(list);
        page.schema.props.forEach(prop => {
          const rowEl = U.el("div", "prop-opt-row");
          const nameInp = U.el("input", "modal-input");
          nameInp.style.flex = "1";
          nameInp.value = prop.name;
          nameInp.addEventListener("input", () => {
            prop.name = nameInp.value || "未命名";
            S.markDirty();
          });
          const typeSel = U.el("select", "modal-input");
          typeSel.style.width = "110px";
          Store.PROP_TYPES.forEach(tp => {
            const o = U.el("option", null, TYPE_LABEL[tp]);
            o.value = tp;
            if (tp === prop.type) o.selected = true;
            typeSel.appendChild(o);
          });
          typeSel.addEventListener("change", () => {
            prop.type = typeSel.value;
            if (prop.type === "select" || prop.type === "multi_select") prop.options = prop.options || [];
            if (prop.type === "checkbox") { this.rows().forEach(r => { if (r.props[prop.id] == null) r.props[prop.id] = false; }); }
            if (prop.type === "multi_select") { this.rows().forEach(r => { if (!Array.isArray(r.props[prop.id])) r.props[prop.id] = []; }); }
            if (prop.type === "relation") { prop.relation = prop.relation || { dbId: null }; this.rows().forEach(r => { if (!Array.isArray(r.props[prop.id])) r.props[prop.id] = []; }); }
            if (prop.type === "rollup") prop.rollup = prop.rollup || { relationPropId: null, targetPropId: null, aggregate: "count_all" };
            if (prop.type === "formula") prop.formula = prop.formula || { expr: "" };
            S.markDirty();
            render();
          });
          const del = U.el("button", "icon-btn", U.icon("trash-2", { size: 16 }));
          del.title = "删除属性";
          del.addEventListener("click", () => {
            if (page.schema.props.length <= 1) { U.toast("至少保留一个属性"); return; }
            page.schema.props = page.schema.props.filter(p => p.id !== prop.id);
            this.rows().forEach(r => delete r.props[prop.id]);
            S.markDirty();
            render();
          });
          rowEl.appendChild(nameInp);
          rowEl.appendChild(typeSel);
          rowEl.appendChild(del);
          list.appendChild(rowEl);
          if (prop.type === "select" || prop.type === "multi_select") {
            const opts = U.el("div", null);
            opts.style.margin = "2px 0 6px 6px";
            opts.style.display = "flex";
            opts.style.flexWrap = "wrap";
            opts.style.gap = "4px";
            (prop.options || []).forEach(o => {
              const p = U.el("span", "pill " + U.pillColor(o), U.esc(o) + ' <span class="pill-x">✕</span>');
              p.title = "删除选项";
              p.addEventListener("click", () => {
                prop.options = prop.options.filter(x => x !== o);
                this.rows().forEach(r => {
                  if (prop.type === "select" && r.props[prop.id] === o) r.props[prop.id] = "";
                  if (prop.type === "multi_select") r.props[prop.id] = (r.props[prop.id] || []).filter(x => x !== o);
                });
                S.markDirty();
                render();
              });
              opts.appendChild(p);
            });
            const add = U.el("span", "pill p-gray", "＋ 添加");
            add.addEventListener("click", async () => {
              const name = await U.promptModal({ title: "添加选项", placeholder: "选项名称" });
              if (name && name.trim()) {
                prop.options = prop.options || [];
                prop.options.push(name.trim());
                S.markDirty();
                render();
              }
            });
            opts.appendChild(add);
            list.appendChild(opts);
          }
          if (prop.type === "relation") {
            const cfg = U.el("div", "prop-cfg");
            const label = U.el("span", "prop-cfg-label", "关联数据库：");
            const sel = U.el("select", "modal-input");
            sel.style.width = "200px";
            const opt = U.el("option", null, "（选择数据库）"); opt.value = ""; sel.appendChild(opt);
            S.allPages().filter(p => p.database && !p.deleted).forEach(d => {
              const o = U.el("option", null, U.segsText(d.title) || "未命名数据库");
              o.value = d.id;
              if ((prop.relation && prop.relation.dbId) === d.id) o.selected = true;
              sel.appendChild(o);
            });
            sel.addEventListener("change", () => {
              prop.relation = prop.relation || {};
              prop.relation.dbId = sel.value || null;
              S.markDirty();
            });
            cfg.appendChild(label); cfg.appendChild(sel);
            list.appendChild(cfg);
          } else if (prop.type === "rollup") {
            const cfg = U.el("div", "prop-cfg");
            const relProps = page.schema.props.filter(p => p.type === "relation");
            const relSel = U.el("select", "modal-input");
            const ropt = U.el("option", null, "（关联属性）"); ropt.value = ""; relSel.appendChild(ropt);
            relProps.forEach(r => { const o = U.el("option", null, r.name); o.value = r.id; if ((prop.rollup && prop.rollup.relationPropId) === r.id) o.selected = true; relSel.appendChild(o); });
            relSel.addEventListener("change", () => {
              prop.rollup = prop.rollup || {};
              prop.rollup.relationPropId = relSel.value || null;
              prop.rollup.targetPropId = null;
              S.markDirty();
              render();
            });
            const tSel = U.el("select", "modal-input");
            const relP = relProps.find(r => r.id === (prop.rollup && prop.rollup.relationPropId));
            const tdb = relP ? S.relationTargetPage(relP) : null;
            const topt = U.el("option", null, "（目标属性）"); topt.value = ""; tSel.appendChild(topt);
            if (tdb) tdb.schema.props.forEach(r => { const o = U.el("option", null, r.name); o.value = r.id; if ((prop.rollup && prop.rollup.targetPropId) === r.id) o.selected = true; tSel.appendChild(o); });
            tSel.addEventListener("change", () => {
              prop.rollup = prop.rollup || {};
              prop.rollup.targetPropId = tSel.value || null;
              S.markDirty();
            });
            const aggSel = U.el("select", "modal-input");
            [["count_all", "计数（全部）"], ["count_values", "计数（非空）"], ["sum", "求和"], ["average", "平均值"], ["min", "最小值"], ["max", "最大值"], ["unique", "去重值"], ["show_original", "原值"], ["earliest_date", "最早日期"], ["latest_date", "最晚日期"]].forEach(a => {
              const o = U.el("option", null, a[1]); o.value = a[0];
              if (((prop.rollup && prop.rollup.aggregate) || "count_all") === a[0]) o.selected = true;
              aggSel.appendChild(o);
            });
            aggSel.addEventListener("change", () => {
              prop.rollup = prop.rollup || {};
              prop.rollup.aggregate = aggSel.value;
              S.markDirty();
            });
            cfg.appendChild(relSel); cfg.appendChild(tSel); cfg.appendChild(aggSel);
            list.appendChild(cfg);
          } else if (prop.type === "formula") {
            const cfg = U.el("div", "prop-cfg");
            const inp = U.el("input", "modal-input");
            inp.placeholder = '例如：if(prop("进度") > 50, "高", "低")';
            inp.value = (prop.formula && prop.formula.expr) || "";
            inp.addEventListener("input", () => {
              prop.formula = prop.formula || {};
              prop.formula.expr = inp.value;
              S.markDirty();
            });
            cfg.appendChild(inp);
            list.appendChild(cfg);
            const hint = U.el("div", "prop-cfg-hint", '函数：if / concat / round / floor / ceil / abs / max / min / length / empty / contains / lower / upper / trim / replace / toNumber / now；用 prop("属性名") 引用属性');
            list.appendChild(hint);
          }
        });
      };
      render();
      const foot = U.el("div", null);
      const addProp = U.el("button", "db-btn", "＋ 添加属性");
      addProp.addEventListener("click", () => this.openPropDialog(modal.close));
      foot.appendChild(addProp);
      modal.foot.appendChild(foot);
    },

    openPropDialog(closeCb) {
      const page = this.page;
      const modal = U.modal({ title: "添加属性", size: "sm" });
      const name = U.el("input", "modal-input");
      name.placeholder = "属性名称";
      name.style.marginBottom = "8px";
      modal.body.appendChild(name);
      const typeSel = U.el("select", "modal-input");
      Store.PROP_TYPES.forEach(tp => {
        const o = U.el("option", null, TYPE_LABEL[tp]);
        o.value = tp;
        typeSel.appendChild(o);
      });
      modal.body.appendChild(typeSel);
      const ok = U.el("button", "db-btn primary", "创建");
      ok.style.marginLeft = "auto";
      modal.foot.appendChild(ok);
      const doCreate = () => {
        const prop = Store.defaultProp(name.value.trim() || "属性", typeSel.value);
        if (prop.type === "select") prop.options = ["选项 1"];
        if (prop.type === "relation") prop.relation = { dbId: null };
        if (prop.type === "rollup") prop.rollup = { relationPropId: null, targetPropId: null, aggregate: "count_all" };
        if (prop.type === "formula") prop.formula = { expr: "" };
        page.schema.props.push(prop);
        S.markDirty();
        modal.close();
        if (closeCb) closeCb();
        this.render(page);
      };
      ok.addEventListener("click", doCreate);
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") doCreate(); });
      name.focus();
    },

    /* ================= Filter modal ================= */
    filterOpNeedsValue(op) {
      return !["empty", "not_empty", "checked", "unchecked"].includes(op);
    },

    filterValueInput(rule, prop) {
      if (prop.type === "select") {
        const sel = U.el("select", "modal-input");
        sel.style.width = "140px";
        (prop.options || []).forEach(o => { const op = U.el("option", null, o); op.value = o; if (o === rule.value) op.selected = true; sel.appendChild(op); });
        sel.addEventListener("change", () => { rule.value = sel.value; S.markDirty(); });
        return sel;
      }
      const inp = U.el("input", "modal-input");
      inp.style.width = "140px";
      if (prop.type === "number") inp.type = "number";
      else if (prop.type === "date") inp.type = "date";
      else inp.type = "text";
      inp.value = rule.value == null ? "" : rule.value;
      inp.addEventListener("input", () => { rule.value = inp.value; S.markDirty(); });
      return inp;
    },

    openFilterModal() {
      const page = this.page;
      const modal = U.modal({ title: "筛选", onClose: () => this.render(page) });
      const list = U.el("div", null);
      modal.body.appendChild(list);
      const fs = page.viewState.filter = page.viewState.filter || { rules: [] };

      const render = () => {
        U.clear(list);
        if (!fs.rules.length) {
          const empty = U.el("div", "empty-state");
          empty.style.padding = "20px";
          empty.textContent = "没有筛选条件，将显示全部记录";
          list.appendChild(empty);
        }
        fs.rules.forEach((rule, idx) => {
          const prop = page.schema.props.find(p => p.id === rule.propId);
          const row = U.el("div", "prop-opt-row");
          const propSel = U.el("select", "modal-input");
          propSel.style.flex = "1";
          page.schema.props.forEach(p => { const o = U.el("option", null, p.name); o.value = p.id; if (p.id === rule.propId) o.selected = true; propSel.appendChild(o); });
          propSel.addEventListener("change", () => {
            rule.propId = propSel.value;
            const np = page.schema.props.find(p => p.id === propSel.value);
            rule.op = this.filterOpsFor(np)[0].id;
            rule.value = "";
            S.markDirty();
            render();
          });
          row.appendChild(propSel);
          const opSel = U.el("select", "modal-input");
          opSel.style.width = "110px";
          this.filterOpsFor(prop).forEach(op => { const o = U.el("option", null, op.label); o.value = op.id; if (op.id === rule.op) o.selected = true; opSel.appendChild(o); });
          opSel.addEventListener("change", () => { rule.op = opSel.value; S.markDirty(); render(); });
          row.appendChild(opSel);
          if (this.filterOpNeedsValue(rule.op)) row.appendChild(this.filterValueInput(rule, prop));
          const del = U.el("button", "icon-btn", U.icon("trash-2", { size: 16 }));
          del.title = "删除此条件";
          del.addEventListener("click", () => { fs.rules.splice(idx, 1); S.markDirty(); render(); });
          row.appendChild(del);
          list.appendChild(row);
        });
      };
      render();
      const foot = U.el("div", null);
      const add = U.el("button", "db-btn", "＋ 添加筛选条件");
      add.addEventListener("click", () => {
        const p0 = page.schema.props[0];
        fs.rules.push({ propId: p0.id, op: this.filterOpsFor(p0)[0].id, value: "" });
        S.markDirty();
        render();
      });
      foot.appendChild(add);
      const clear = U.el("button", "db-btn", "清除全部");
      clear.addEventListener("click", () => { fs.rules = []; S.markDirty(); render(); });
      foot.appendChild(clear);
      modal.foot.appendChild(foot);
    },

    openSortModal() {
      const page = this.page;
      const modal = U.modal({ title: "排序", onClose: () => this.render(page) });
      const list = U.el("div", null);
      modal.body.appendChild(list);
      const ss = page.viewState.sort = page.viewState.sort || { rules: [] };

      const render = () => {
        U.clear(list);
        if (!ss.rules.length) {
          const empty = U.el("div", "empty-state");
          empty.style.padding = "20px";
          empty.textContent = "没有排序规则，将按创建顺序显示";
          list.appendChild(empty);
        }
        ss.rules.forEach((rule, idx) => {
          const row = U.el("div", "prop-opt-row");
          const propSel = U.el("select", "modal-input");
          propSel.style.flex = "1";
          page.schema.props.forEach(p => { const o = U.el("option", null, p.name); o.value = p.id; if (p.id === rule.propId) o.selected = true; propSel.appendChild(o); });
          propSel.addEventListener("change", () => { rule.propId = propSel.value; S.markDirty(); });
          row.appendChild(propSel);
          const dirSel = U.el("select", "modal-input");
          dirSel.style.width = "110px";
          [["asc", "升序 ↑"], ["desc", "降序 ↓"]].forEach(d => { const o = U.el("option", null, d[1]); o.value = d[0]; if ((rule.dir || "asc") === d[0]) o.selected = true; dirSel.appendChild(o); });
          dirSel.addEventListener("change", () => { rule.dir = dirSel.value; S.markDirty(); });
          row.appendChild(dirSel);
          const del = U.el("button", "icon-btn", U.icon("trash-2", { size: 16 }));
          del.title = "删除此排序";
          del.addEventListener("click", () => { ss.rules.splice(idx, 1); S.markDirty(); render(); });
          row.appendChild(del);
          list.appendChild(row);
        });
      };
      render();
      const foot = U.el("div", null);
      const add = U.el("button", "db-btn", "＋ 添加排序");
      add.addEventListener("click", () => {
        const p0 = page.schema.props[0];
        ss.rules.push({ propId: p0.id, dir: "asc" });
        S.markDirty();
        render();
      });
      foot.appendChild(add);
      const clear = U.el("button", "db-btn", "清除全部");
      clear.addEventListener("click", () => { ss.rules = []; S.markDirty(); render(); });
      foot.appendChild(clear);
      modal.foot.appendChild(foot);
    },

    /* board drag & drop */
    onDragOver(e) {
      const card = e.target.closest ? e.target.closest(".board-card") : null;
      const col = e.target.closest ? e.target.closest(".board-col") : null;
      if (card) {
        e.preventDefault();
        card.classList.add("drop-over");
        e.dataTransfer.dropEffect = "move";
      } else if (col) {
        e.preventDefault();
        col.classList.add("drop-over");
        e.dataTransfer.dropEffect = "move";
      }
    },

    onDrop(e) {
      e.preventDefault();
      const page = this.page;
      const id = e.dataTransfer.getData("text/plain");
      const col = e.target.closest ? e.target.closest(".board-col") : null;
      document.querySelectorAll(".board-col.drop-over").forEach(c => c.classList.remove("drop-over"));
      if (!id || !col || !page) return;
      const row = S.getPage(id);
      if (!row) return;
      const prop = page.schema.props.find(p => p.id === col.dataset.prop);
      if (!prop) return;
      const v = col.dataset.group === "__none__" ? "" : col.dataset.group;
      this.setRowValue(row, prop, v);
      this.render(page);
    },
  };

  global.Database = Database;
})(window);
