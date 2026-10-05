/* KT sync v5.2: per-question records, per-note records, and resumable positions. */
(() => {
  if (!window.KT_BRIDGE) return;
  const KEY = "kt-cloud-journal-v1",
    BACKUP = "kt-cloud-before-first-sync-v1";
  const canonical = (x) =>
    x && typeof x === "object"
      ? Array.isArray(x)
        ? x.map(canonical)
        : Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, canonical(x[k])]),
          )
      : x;
  const id = () => crypto.randomUUID();
  const same = (a, b) =>
    JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const read = () => {
    const raw = localStorage.getItem(KEY);
    return raw
      ? JSON.parse(raw)
      : { connected: false, records: {}, conflicts: {} };
  };
  const write = (j) => localStorage.setItem(KEY, JSON.stringify(j));
  function snapshot() {
    const s = window.KT_BRIDGE.snapshot(),
      out = {};
    for (const n of new Set([
      ...Object.keys(s.progress),
      ...Object.keys(s.reviewQueue),
    ]))
      out["q:" + n] = {
        progress: s.progress[n] || null,
        review: s.reviewQueue[n] || null,
      };
    for (const d of s.doubts) out["d:" + d.id] = { doubt: d };
    out["s:last"] = {
      lastStudyNumber: s.appState.lastStudyNumber || 1,
      updatedAt: s.appState.lastStudyUpdatedAt || "",
    };
    for (const [key, v] of Object.entries(s.appState.sessionPositions || {}))
      out["s:" + key] = { position: v };
    return out;
  }
  function capture() {
    const existing = localStorage.getItem(KEY),
      j = read(),
      now = snapshot();
    for (const key of new Set([
      ...Object.keys(j.records),
      ...Object.keys(now),
    ])) {
      const body = now[key] ?? null,
        old = j.records[key];
      if (!old || !same(old.body, body))
        j.records[key] = {
          body,
          rev: old?.rev || 0,
          dirty: !!existing,
          mutation: id(),
        };
    }
    write(j);
  }
  function apply(j) {
    const base = window.KT_BRIDGE.snapshot(),
      s = {
        progress: {},
        reviewQueue: {},
        doubts: [],
        appState: {
          ...base.appState,
          sessionPositions: {},
          lastStudyNumber: 1,
        },
      };
    for (const [key, r] of Object.entries(j.records)) {
      const body = r.body;
      if (body === null) continue;
      if (key.startsWith("q:")) {
        const n = key.slice(2);
        if (!(window.KT_DATA || []).some((q) => String(q.studyNumber) === n))
          continue;
        if (body.progress) s.progress[n] = body.progress;
        if (body.review) s.reviewQueue[n] = body.review;
      } else if (key.startsWith("d:")) {
        if (body.doubt) s.doubts.push(body.doubt);
      } else if (key === "s:last") {
        s.appState.lastStudyNumber = body.lastStudyNumber || 1;
        s.appState.lastStudyUpdatedAt = body.updatedAt || "";
      } else if (key.startsWith("s:") && body.position)
        Object.defineProperty(s.appState.sessionPositions, key.slice(2), {
          value: body.position,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    window.KT_BRIDGE.apply(s);
  }
  capture();
  window.addEventListener("kt-state-saved", () => {
    try {
      capture();
      window.dispatchEvent(new Event("kt-sync-pending"));
    } catch {
      window.dispatchEvent(
        new CustomEvent("kt-sync-warning", {
          detail:
            "KTの記録は端末に保存しましたが、同期用の記録を保存できませんでした。空き容量を確認してください。",
        }),
      );
    }
  });
  function commit(j) {
    const old = localStorage.getItem(KEY);
    write(j);
    try {
      apply(j);
    } catch (e) {
      if (old === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, old);
      throw e;
    }
  }
  function summary() {
    const j = read();
    return {
      pending: Object.entries(j.records).filter(
        ([k, r]) => r.dirty && !j.conflicts[k],
      ).length,
      conflicts: Object.keys(j.conflicts).length,
      connected: j.connected,
    };
  }
  async function sync(request, cfg, auth) {
    capture();
    const start = read();
    if (!start.connected && !localStorage.getItem(BACKUP))
      localStorage.setItem(BACKUP, JSON.stringify(window.KT_BRIDGE.snapshot()));
    const sent = Object.entries(start.records).filter(
      ([k, r]) => r.dirty && !start.conflicts[k],
    );
    const reply = await request(
      cfg,
      "/rest/v1/rpc/kt_records_sync_v1",
      {
        seed: Object.entries(start.records).map(([key, r]) => ({
          key,
          body: r.body,
          mutation: r.mutation,
          base: 0,
        })),
        batch: sent.map(([key, r]) => ({
          key,
          body: r.body,
          mutation: r.mutation,
          base: r.rev,
        })),
      },
      auth.access_token,
    );
    if (!Array.isArray(reply.rows) || !Array.isArray(reply.conflicts))
      throw new Error(
        "KT同期の応答が正しくありません。最新のSQLを実行してください。",
      );
    const j = read(),
      conflicts = new Set(reply.conflicts),
      serverKeys = new Set(reply.rows.map((r) => r.key));
    for (const row of reply.rows) {
      if (
        typeof row.key !== "string" ||
        !/^([qds]):/.test(row.key) ||
        !Number.isInteger(row.revision)
      )
        throw new Error("KT同期データの形式が正しくありません。");
      const local = j.records[row.key],
        wasSent = sent.find(([key]) => key === row.key)?.[1];
      if (conflicts.has(row.key) && local?.dirty) {
        // Resuming positions are not learning results: use the later position automatically.
        if (row.key.startsWith("s:")) {
          const localTime =
            local.body?.updatedAt || local.body?.position?.updatedAt || "";
          const remoteTime =
            row.body?.updatedAt || row.body?.position?.updatedAt || "";
          j.records[row.key] =
            localTime > remoteTime
              ? { ...local, rev: row.revision }
              : {
                  body: row.body,
                  mutation: row.mutation,
                  rev: row.revision,
                  dirty: false,
                };
        } else
          j.conflicts[row.key] = {
            body: row.body,
            mutation: row.mutation,
            rev: row.revision,
          };
      } else if (j.conflicts[row.key])
        j.conflicts[row.key] = {
          body: row.body,
          mutation: row.mutation,
          rev: row.revision,
        };
      else if (local?.dirty) {
        if (
          (wasSent && wasSent.mutation === local.mutation) ||
          (reply.seeded && start.records[row.key]?.mutation === local.mutation)
        )
          j.records[row.key] = {
            body: row.body,
            mutation: row.mutation,
            rev: row.revision,
            dirty: false,
          };
        else if (wasSent || reply.seeded)
          j.records[row.key] = { ...local, rev: row.revision };
      } else
        j.records[row.key] = {
          body: row.body,
          mutation: row.mutation,
          rev: row.revision,
          dirty: false,
        };
    }
    // On the second device, the established cloud baseline wins over old untouched local records.
    if (!start.connected)
      for (const [key, r] of Object.entries(j.records))
        if (!serverKeys.has(key) && !r.dirty) delete j.records[key];
    j.connected = true;
    commit(j);
    return summary();
  }
  function conflicts() {
    const j = read();
    return Object.entries(j.conflicts).map(([key, remote]) => ({
      key,
      local: j.records[key]?.body ?? null,
      remote: remote.body,
    }));
  }
  function resolve(key, choice) {
    const j = read(),
      remote = j.conflicts[key],
      local = j.records[key];
    if (!remote || !local) return;
    const archive = JSON.parse(
      localStorage.getItem("kt-cloud-conflict-history-v1") || "[]",
    );
    archive.push({ key, local, remote, choice, at: new Date().toISOString() });
    localStorage.setItem(
      "kt-cloud-conflict-history-v1",
      JSON.stringify(archive.slice(-100)),
    );
    j.records[key] =
      choice === "local"
        ? { ...local, rev: remote.rev, dirty: true, mutation: id() }
        : { ...remote, dirty: false };
    delete j.conflicts[key];
    commit(j);
    window.dispatchEvent(new Event("kt-sync-pending"));
  }
  function downloadBackup() {
    const raw = localStorage.getItem(BACKUP);
    if (!raw) throw new Error("初回同期前のバックアップはまだありません。");
    const body = {
      format: "kt-quiz-backup",
      appVersion: "5.2.0",
      questionCount: (window.KT_DATA || []).length,
      exportedAt: new Date().toISOString(),
      ...JSON.parse(raw),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(body)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "KT_before_first_sync.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function downloadConflicts() {
    const raw = localStorage.getItem("kt-cloud-conflict-history-v1") || "[]";
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify({
            format: "kt-conflict-history",
            records: JSON.parse(raw),
          }),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "KT_conflict_history.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  window.KT_SYNC = {
    sync,
    summary,
    conflicts,
    resolve,
    downloadBackup,
    downloadConflicts,
    capture,
  };
})();

/* KT mathematics extension v5. No third-party scripts; card images stay in IndexedDB. */
(() => {
  "use strict";
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const uid = () => crypto.randomUUID();
  const today = () =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(
      new Date(),
    );
  const plusDays = (n) => {
    const d = new Date(today() + "T12:00:00+09:00");
    d.setUTCDate(d.getUTCDate() + n);
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(
      d,
    );
  };
  const MAX_CARD = 12 * 1024 * 1024;
  const dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open("kt-math-v5", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("cards", { keyPath: "id" });
      r.result.createObjectStore("meta");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  async function transaction(store, mode, run) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      try {
        result = run(tx.objectStore(store));
      } catch (e) {
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("保存を中止しました"));
    });
  }
  const getAll = () => transaction("cards", "readonly", (s) => s.getAll());
  const getMeta = (k) => transaction("meta", "readonly", (s) => s.get(k));
  const setMeta = (k, v) =>
    transaction("meta", "readwrite", (s) => s.put(v, k));
  const putCards = (xs) =>
    transaction("cards", "readwrite", (s) => {
      xs.forEach((x) => s.put(x));
    });
  let cards = [],
    editor = null,
    changed = false,
    queue = [],
    position = 0,
    sessionKey = "",
    revealed = false;
  let syncBusy = false,
    syncTimer,
    filter = "すべて",
    query = "",
    message = "",
    imageJobs = 0;
  let subject = "math";
  const subjects = {
    math: {
      label: "数学",
      eyebrow: "ACTUARIAL MATHEMATICS",
      fields: ["確率", "統計", "モデリング"],
      question: "例：指数分布の最小値は、どの分布に従う？",
      theme: "例：指数分布",
    },
    economy: {
      label: "経済・投資理論",
      eyebrow: "ECONOMICS & INVESTMENT THEORY",
      fields: ["ミクロ経済学", "マクロ経済学", "投資理論"],
      question: "例：この公式を使える条件は？",
      theme: "例：CAPM・効用関数",
    },
  };
  const subjectOf = (c) => c.subject || "math";
  const fieldKey = () =>
    subject === "math" ? "lastField" : "lastField:" + subject;
  const fields = () => [
    ...new Set([
      ...subjects[subject].fields,
      ...cards
        .filter((c) => subjectOf(c) === subject && !c.deleted)
        .map((c) => c.field)
        .filter(Boolean),
      "未分類",
    ]),
  ];
  const root = document.createElement("dialog");
  root.id = "km-app";
  root.className = "km";
  root.innerHTML =
    '<header class="km-header"><button data-action="close" aria-label="自作カードを閉じる">← KT</button><strong>数学カード</strong><button data-action="settings">同期・保存</button></header><div class="km-status" role="status" aria-live="polite"></div><main class="km-main"></main><div class="km-toast" role="status" aria-live="polite"></div>';
  document.body.append(root);
  const main = root.querySelector("main");
  const notice = (t) => {
    root.querySelector(".km-toast").textContent = t;
    clearTimeout(notice.timer);
    notice.timer = setTimeout(
      () => (root.querySelector(".km-toast").textContent = ""),
      6500,
    );
  };
  const guard =
    (fn) =>
    async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        console.error(e);
        notice(e.message || "処理できませんでした。もう一度お試しください。");
      }
    };
  const active = () =>
    cards.filter((c) => !c.deleted && subjectOf(c) === subject);
  const ready = () => active().filter((c) => !c.draft);
  const due = (c) => !c.draft && !!c.review?.due && c.review.due <= today();
  async function refresh() {
    cards = await getAll();
    await status();
  }
  async function status() {
    const auth = await getMeta("auth");
    const pending =
      cards.filter((c) => c.dirty).length +
      (window.KT_SYNC?.summary().pending || 0);
    root.querySelector(".km-status").textContent =
      message ||
      (auth
        ? navigator.onLine
          ? `同期待ち ${pending}件`
          : `オフライン・同期待ち ${pending}件`
        : "端末に保存中 · 自動同期は未接続");
    const statusButton = document.getElementById("ktSyncButton");
    if (statusButton)
      statusButton.textContent =
        "KT・自作カードの同期設定 · " +
        root.querySelector(".km-status").textContent;
  }
  function requestSync() {
    message = "";
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => guard(sync)(), 1200);
  }
  async function saveCard(c) {
    c.updatedAt = new Date().toISOString();
    c.mutation = uid();
    c.dirty = true;
    await putCards([c]);
    await refresh();
    requestSync();
  }
  function leaveEditor() {
    return !changed || confirm("編集中の変更を保存せずに移動しますか？");
  }
  function close() {
    if (!leaveEditor()) return;
    editor = null;
    changed = false;
    root.close();
  }
  root.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  window.addEventListener("beforeunload", (e) => {
    if (changed) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  function header(title, sub = "") {
    return `<div class="km-heading"><span class="km-eyebrow">${esc(subjects[subject].eyebrow)}</span><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}</div>`;
  }
  const button = (action, text, cls = "") =>
    `<button type="button" data-action="${action}" class="${cls}">${text}</button>`;
  async function home() {
    root.querySelector(".km-header strong").textContent =
      subjects[subject].label + "・自作カード";
    editor = null;
    changed = false;
    await refresh();
    const xs = active(),
      rs = ready(),
      ds = rs.filter(due);
    main.innerHTML =
      header(
        "間違いを、次の正解へ。",
        "公式も、条件も、解法の入口も。一つずつ思い出す。",
      ) +
      `<div class="km-stats"><div><strong>${ds.length}</strong><span>今日の復習</span></div><div><strong>${rs.filter((x) => !x.review?.rating).length}</strong><span>未学習</span></div><div><strong>${xs.filter((x) => x.draft).length}</strong><span>下書き</span></div></div><div class="km-actions">${button("due", "今日の復習を始める", "km-primary")}${button("new", "＋ カードを追加")}</div><div class="km-row">${button("study", "すべて・続きから")}${button("fresh", "未学習を練習")}</div><section class="km-section"><div class="km-row km-between"><h2>カード一覧 <small>${xs.length}枚</small></h2></div><div class="km-filters"><input id="km-search" type="search" placeholder="問い・テーマ・メモを検索" aria-label="カード検索" value="${esc(query)}"><select id="km-filter" aria-label="分野"><option>すべて</option>${[...fields(), "下書き"].map((t) => `<option ${filter === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div><div id="km-list"></div></section><div class="km-addbar">${button("new", "＋ カードを追加", "km-primary")}</div>`;
    renderList();
    main.scrollTop = 0;
  }
  function renderList() {
    const stats = root.querySelectorAll(".km-stats strong");
    if (stats.length) {
      stats[0].textContent = ready().filter(due).length;
      stats[1].textContent = ready().filter((c) => !c.review?.rating).length;
      stats[2].textContent = active().filter((c) => c.draft).length;
    }
    const xs = active()
      .filter(
        (c) =>
          (filter === "すべて" ||
            (filter === "下書き" ? c.draft : c.field === filter)) &&
          [c.question, c.answer, c.theme, c.note, c.source]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    root.querySelector("#km-list").innerHTML = xs.length
      ? xs
          .map(
            (c) =>
              `<button class="km-cardrow" data-edit="${esc(c.id)}"><span class="km-tag">${esc(c.field)}${c.draft ? " · 下書き" : due(c) ? " · 復習" : c.review?.rating ? " · " + { good: "○", meh: "△", bad: "×" }[c.review.rating] : " · 未学習"}</span><strong>${esc(c.question || "画像のカード")}</strong><span>${esc(c.theme || c.note || "タップして編集")}${c.conflict ? " · 別端末の変更を保護したコピー" : ""}</span></button>`,
          )
          .join("")
      : '<div class="km-empty"><b>覚えたいことを一つ、追加しましょう。</b><p>問いと答えは、文章でも画像でも。<br>画像だけ下書きに保存することもできます。</p></div>';
  }
  async function edit(id) {
    if (!leaveEditor()) return;
    const c = cards.find((x) => x.id === id);
    editor = c
      ? structuredClone(c)
      : {
          id: uid(),
          subject,
          question: "",
          answer: "",
          qImages: [],
          aImages: [],
          field: (await getMeta(fieldKey())) || "未分類",
          theme: "",
          note: "",
          source: "",
          draft: true,
          createdAt: new Date().toISOString(),
          rev: 0,
        };
    changed = false;
    main.innerHTML =
      header(
        c ? "カードを編集" : "新しいカード",
        subject === "economy"
          ? "解けなかった原因の知識を、一つの問いと答えに。答えは画像でも登録できます。"
          : "問いを短く、答えはスクショで。分類は後からでも大丈夫。",
      ) +
      `<form id="km-form"><label class="km-label">問い<textarea id="km-question" placeholder="${esc(subjects[subject].question)}">${esc(editor.question)}</textarea></label>${imageBox("q")}<label class="km-label">答え<textarea id="km-answer" placeholder="文章・画像のどちらか、または両方">${esc(editor.answer)}</textarea></label>${imageBox("a")}<div class="km-two"><label class="km-label">分野<select id="km-field">${fields()
        .map(
          (t) =>
            `<option ${editor.field === t ? "selected" : ""}>${esc(t)}</option>`,
        )
        .join(
          "",
        )}</select></label><label class="km-label">テーマ<input id="km-theme" placeholder="${esc(subjects[subject].theme)}" value="${esc(editor.theme)}"></label></div><details ${subject === "economy" || editor.note || editor.source ? "open" : ""}><summary>間違えた理由・出典（任意）</summary><label class="km-label">間違えた理由<textarea id="km-note" placeholder="例：公式は覚えていたが、使える条件を取り違えた">${esc(editor.note)}</textarea></label><label class="km-label">出典<input id="km-source" placeholder="例：2024年度 問1（3）" value="${esc(editor.source)}"></label></details><div class="km-editor-actions">${button("save", "保存して復習に追加", "km-primary")}${button("draft", "下書き保存")}${button("home", "戻る")}</div>${c ? `<div class="km-row">${button("one", "このカードを練習")}${button("delete", "削除", "km-danger")}</div>` : ""}</form>`;
    drawImages("q");
    drawImages("a");
    main.scrollTop = 0;
  }
  let pasteSide = "a";
  function imageBox(side) {
    return `<div class="km-imagebox" data-side="${side}" tabindex="0"><div class="km-row"><label class="km-file">＋ 画像を選ぶ<input type="file" accept="image/*" multiple data-file="${side}"></label><label class="km-file">撮影<input type="file" accept="image/*" capture="environment" data-file="${side}"></label></div><p>ここに画像をドロップ、または選択して貼り付け（1面6枚まで）</p><div id="km-images-${side}" class="km-thumbs"></div></div>`;
  }
  function drawImages(side) {
    root.querySelector(`#km-images-${side}`).innerHTML = editor[side + "Images"]
      .map(
        (src, i) =>
          `<div class="km-thumb"><button type="button" data-zoom="${side}:${i}" aria-label="画像${i + 1}を拡大"><img src="${src}" alt="${side === "q" ? "問い" : "答え"}の画像${i + 1}"></button><div class="km-row"><button type="button" data-crop="${side}:${i}">切り抜く</button><button type="button" data-remove="${side}:${i}" aria-label="画像${i + 1}を削除">削除</button></div></div>`,
      )
      .join("");
  }
  const loadImage = (src) =>
    new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () =>
        rej(
          new Error(
            "画像を読み込めません。JPEG・PNGなどに変換して再度選択してください。",
          ),
        );
      im.src = src;
    });
  async function readImage(file) {
    if (!file.type.startsWith("image/") || file.size > 25 * 1024 * 1024)
      throw new Error("25MB以下の画像を選択してください。");
    const url = URL.createObjectURL(file);
    try {
      const im = await loadImage(url);
      const factor = Math.min(1, 2200 / Math.max(im.width, im.height));
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(im.width * factor));
      cv.height = Math.max(1, Math.round(im.height * factor));
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(im, 0, 0, cv.width, cv.height);
      const src = cv.toDataURL(
        file.type === "image/png" ? "image/png" : "image/jpeg",
        0.92,
      );
      if (src.length > MAX_CARD / 2)
        throw new Error(
          "画像が大きすぎます。必要な範囲をスクショして選び直してください。",
        );
      return src;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function addImages(files, side) {
    const owner = editor;
    imageJobs++;
    try {
      for (const f of files) {
        if (!f.type.startsWith("image/")) continue;
        if (owner[side + "Images"].length >= 6)
          throw new Error("画像は1面につき6枚までです。");
        const src = await readImage(f);
        if (editor !== owner) return;
        owner[side + "Images"].push(src);
        changed = true;
        drawImages(side);
      }
    } finally {
      imageJobs--;
    }
  }
  function collect() {
    for (const key of [
      "question",
      "answer",
      "field",
      "theme",
      "note",
      "source",
    ])
      editor[key] = root.querySelector("#km-" + key).value.trim();
  }
  async function saveEditor(draft) {
    if (imageJobs)
      throw new Error("画像の読み込みが終わるまでお待ちください。");
    collect();
    if (
      !draft &&
      (!(editor.question || editor.qImages.length) ||
        !(editor.answer || editor.aImages.length))
    )
      throw new Error(
        "問いと答えを、それぞれ文章または画像で登録してください。",
      );
    if (
      draft &&
      !(
        editor.question ||
        editor.answer ||
        editor.qImages.length ||
        editor.aImages.length
      )
    )
      throw new Error("文章または画像を一つ追加してください。");
    if (JSON.stringify(editor).length > MAX_CARD)
      throw new Error(
        "カードが大きすぎます。画像を減らすか、カードを分けてください。",
      );
    editor.draft = draft;
    await saveCard(editor);
    await setMeta(fieldKey(), editor.field);
    changed = false;
    await home();
    notice(draft ? "下書きを保存しました" : "カードを保存しました");
  }
  function zoom(src) {
    const d = document.createElement("dialog");
    d.className = "km-lightbox";
    d.innerHTML =
      '<button type="button">閉じる ×</button><p>画像はピンチ、またはスクロールして確認できます。</p><div><img alt="拡大画像"></div>';
    d.querySelector("img").src = src;
    document.body.append(d);
    d.querySelector("button").onclick = () => d.close();
    d.addEventListener("close", () => d.remove());
    d.showModal();
  }
  function crop(side, index) {
    const d = document.createElement("dialog");
    d.className = "km-crop";
    d.innerHTML =
      '<h2>残したい範囲をなぞる</h2><p>指またはマウスで対角線を引いて選択します。</p><div class="km-cropstage"><img draggable="false" alt="切り抜き範囲を選択"><div class="km-croprect"></div></div><div class="km-row"><button data-apply disabled>切り抜きを適用</button><button data-cancel>キャンセル</button></div>';
    document.body.append(d);
    const im = d.querySelector("img"),
      stage = d.querySelector(".km-cropstage"),
      rect = d.querySelector(".km-croprect");
    im.src = editor[side + "Images"][index];
    let start = null,
      selection = null;
    const point = (e) => {
      const r = im.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      };
    };
    stage.onpointerdown = (e) => {
      start = point(e);
      stage.setPointerCapture(e.pointerId);
    };
    stage.onpointermove = (e) => {
      if (!start) return;
      const p = point(e);
      selection = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
      Object.assign(rect.style, {
        display: "block",
        left: selection.x * 100 + "%",
        top: selection.y * 100 + "%",
        width: selection.w * 100 + "%",
        height: selection.h * 100 + "%",
      });
    };
    stage.onpointerup = () => {
      start = null;
      d.querySelector("[data-apply]").disabled =
        !selection || selection.w < 0.01 || selection.h < 0.01;
    };
    stage.onpointercancel = () => {
      start = null;
    };
    d.querySelector("[data-cancel]").onclick = () => d.close();
    d.querySelector("[data-apply]").onclick = guard(async () => {
      const s = selection,
        cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(s.w * im.naturalWidth));
      cv.height = Math.max(1, Math.round(s.h * im.naturalHeight));
      cv.getContext("2d").drawImage(
        im,
        s.x * im.naturalWidth,
        s.y * im.naturalHeight,
        s.w * im.naturalWidth,
        s.h * im.naturalHeight,
        0,
        0,
        cv.width,
        cv.height,
      );
      editor[side + "Images"][index] = cv.toDataURL("image/png");
      changed = true;
      drawImages(side);
      d.close();
    });
    d.addEventListener("close", () => d.remove());
    d.showModal();
  }
  async function start(mode) {
    if (!leaveEditor()) return;
    editor = null;
    changed = false;
    await refresh();
    let xs = ready().filter(
      (c) => filter === "すべて" || filter === "下書き" || c.field === filter,
    );
    if (mode === "due")
      xs = xs
        .filter(due)
        .sort((a, b) => a.review.due.localeCompare(b.review.due));
    if (mode === "fresh") xs = xs.filter((c) => !c.review?.rating);
    if (mode === "one")
      xs = cards.filter((c) => c.id === start.cardId && !c.deleted && !c.draft);
    queue = xs.map((c) => c.id);
    if (!queue.length) {
      notice(
        "出題できるカードがありません。下書きは編集して保存してください。",
      );
      return;
    }
    position = 0;
    sessionKey =
      (subject === "math" ? "" : subject + ":") + mode + ":" + filter;
    if (mode === "study") {
      const last = await getMeta("position:" + sessionKey);
      const i = queue.indexOf(last);
      if (i >= 0) position = i;
    }
    await study();
  }
  function imageHTML(c, side) {
    return c[side + "Images"]
      .map(
        (src, i) =>
          `<button class="km-studyimage" data-studyzoom="${side}:${i}" aria-label="${side === "q" ? "問い" : "答え"}の画像${i + 1}を拡大"><img src="${src}" alt="${side === "q" ? "問い" : "答え"}の画像${i + 1}"></button>`,
      )
      .join("");
  }
  async function study() {
    revealed = false;
    const c = cards.find((x) => x.id === queue[position] && !x.deleted);
    if (!c) {
      await setMeta("position:" + sessionKey, null);
      main.innerHTML =
        header("おつかれさまでした。", "今回のカードを最後まで確認しました。") +
        button("home", "カード一覧へ", "km-primary");
      return;
    }
    await setMeta("position:" + sessionKey, c.id);
    main.innerHTML = `<div class="km-row km-between">${button("home", "← カード一覧")}<span>${position + 1} / ${queue.length}</span></div><div class="km-study"><span class="km-tag">${esc(c.field)}${c.theme ? " · " + esc(c.theme) : ""}</span><h1>${esc(c.question || "画像の問いに答えてください")}</h1>${imageHTML(c, "q")}<div id="km-answer-panel" hidden><hr><span class="km-eyebrow">答え</span><div class="km-answertext">${esc(c.answer)}</div>${imageHTML(c, "a")}${c.note ? `<aside><b>間違えた理由</b><p>${esc(c.note)}</p></aside>` : ""}${c.source ? `<p class="km-source">出典：${esc(c.source)}</p>` : ""}</div></div><div class="km-studybar"><div id="km-reveal">${button("reveal", "答えを見る", "km-primary")}</div><div id="km-rating" hidden>${button("rate-good", "○ 思い出せた")}${button("rate-meh", "△ 曖昧")}${button("rate-bad", "× もう一度")}</div></div>`;
    main.scrollTop = 0;
  }
  async function rate(rating) {
    if (!revealed) return;
    revealed = false;
    const c = structuredClone(cards.find((x) => x.id === queue[position]));
    const prior = c.review || {};
    const intervals = [1, 3, 7, 14, 30, 60];
    const step =
      rating === "good"
        ? prior.due && prior.due > today()
          ? prior.step || 1
          : Math.min((prior.step || 0) + 1, intervals.length)
        : rating === "bad"
          ? 0
          : prior.step || 0;
    const next =
      rating === "good"
        ? prior.due && prior.due > today()
          ? prior.due
          : plusDays(intervals[Math.max(0, step - 1)])
        : plusDays(1);
    c.review = {
      rating,
      step,
      due: next,
      count: (prior.count || 0) + 1,
      lastAt: new Date().toISOString(),
    };
    c.history = [...(c.history || []), { rating, at: c.review.lastAt }].slice(
      -300,
    );
    try {
      await saveCard(c);
    } catch (e) {
      revealed = true;
      throw e;
    }
    if (rating === "bad" && queue.lastIndexOf(c.id) === position)
      queue.splice(Math.min(position + 4, queue.length), 0, c.id);
    position++;
    await study();
  }
  async function exportFile() {
    const payload = {
      format: "kt-custom-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      cards: await getAll(),
    };
    const blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });
    const file = new File([blob], `KT_custom_backup_${today()}.json`, {
      type: "application/json",
    });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notice("画像・復習履歴を含めて書き出しました");
  }
  function validCard(c) {
    if (
      !c ||
      typeof c.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        c.id,
      ) ||
      typeof c.question !== "string" ||
      typeof c.answer !== "string" ||
      (c.subject !== undefined && !Object.hasOwn(subjects, c.subject))
    )
      return false;
    for (const side of ["qImages", "aImages"])
      if (
        !Array.isArray(c[side]) ||
        c[side].length > 6 ||
        c[side].some(
          (x) =>
            typeof x !== "string" ||
            !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(x),
        )
      )
        return false;
    return JSON.stringify(c).length <= MAX_CARD;
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024)
      throw new Error("読み込みは100MBまでです。");
    const data = JSON.parse(await file.text());
    if (
      !["kt-math-backup", "kt-custom-backup"].includes(data.format) ||
      data.version !== 1 ||
      !Array.isArray(data.cards) ||
      !data.cards.every(validCard)
    )
      throw new Error("自作カードのバックアップ形式ではないか、壊れています。");
    if (
      !confirm(
        `${data.cards.filter((c) => !c.deleted).length}枚を追加します。同じ内容はスキップし、変更のある既存カードは別のコピーとして残します。`,
      )
    )
      return;
    await refresh();
    const adds = [];
    for (const incoming of data.cards) {
      if (incoming.deleted) continue;
      const c = structuredClone(incoming);
      const old = cards.find((x) => x.id === c.id);
      if (
        cards.some(
          (x) =>
            !x.deleted &&
            ((x.id === c.id && x.mutation === c.mutation) ||
              (x.importedId === c.id && x.importedMutation === c.mutation)),
        )
      )
        continue;
      c.importedId = c.id;
      c.importedMutation = c.mutation;
      c.id = old ? uid() : c.id;
      c.rev = 0;
      c.dirty = true;
      c.mutation = uid();
      c.updatedAt = new Date().toISOString();
      adds.push(c);
    }
    await putCards(adds);
    await refresh();
    requestSync();
    await home();
    notice(`${adds.length}枚を読み込みました`);
  }
  function renderKTConflicts() {
    const box = root.querySelector("#kt-conflicts");
    if (!box) return;
    const conflicts = window.KT_SYNC?.conflicts() || [];
    const describe = (key, body) => {
      if (body === null) return "削除された記録";
      if (key.startsWith("q:")) {
        const p = body.progress;
        return p
          ? `${{ good: "○", meh: "△", bad: "×" }[p.rating] || "未学習"}・${p.attempts || 0}回・${p.lastSeen ? new Date(p.lastSeen).toLocaleString("ja-JP") : ""} / 次の復習 ${body.review?.dueDate || "なし"}`
          : "未学習";
      }
      return body.doubt
        ? `${body.doubt.status === "resolved" ? "解決済み" : "未解決"}：${body.doubt.text}`
        : "削除されたメモ";
    };
    box.innerHTML = conflicts.length
      ? conflicts
          .map(
            (c) =>
              `<div class="km-panel"><strong>${esc(c.key.startsWith("q:") ? "学習順 " + c.key.slice(2) : "疑問メモ")}</strong><p>同じ項目を両端末で変更しました。採用する記録を選んでください。選択前の両方の記録はこの端末に退避します。</p><p>この端末：${esc(describe(c.key, c.local))}</p><p>クラウド：${esc(describe(c.key, c.remote))}</p><div class="km-row"><button data-kt-key="${esc(c.key)}" data-kt-choice="local">この端末の記録を採用</button><button data-kt-key="${esc(c.key)}" data-kt-choice="remote">クラウドの記録を採用</button></div></div>`,
          )
          .join("")
      : "<p>確認が必要な変更はありません。</p>";
  }
  async function settings() {
    if (!leaveEditor()) return;
    root.querySelector(".km-header strong").textContent =
      "KT・自作カードの同期";
    editor = null;
    changed = false;
    const auth = await getMeta("auth");
    const cfg = await getMeta("config");
    main.innerHTML =
      header(
        "KT・自作カードの同期",
        "KTの進捗・疑問メモと、数学・経済の自作カード・画像・復習を共通に。",
      ) +
      `<section class="km-panel"><h2>端末間の自動同期</h2><p>初回は、スマホの記録を取り込んだPCから接続してください。2台目はクラウドにある記録を反映します。初回同期前のKT記録は端末内にも退避します。</p><p>${auth ? esc(auth.user?.email || "接続済み") : "同じアカウントでPC・スマホに接続します。"}</p>${!cfg ? "<p>まだ同期先が設定されていません。端末内の登録・復習は使えます。</p>" : ""}${auth ? `<div class="km-row">${button("sync", "今すぐ同期", "km-primary")}${button("logout", "ログアウト")}</div>` : `<form id="km-auth"><label class="km-label">メールアドレス<input id="km-email" type="email" autocomplete="username" required></label><label class="km-label">パスワード<input id="km-password" type="password" autocomplete="current-password" minlength="8" required></label><div class="km-row">${button("login", "ログイン", "km-primary")}${button("signup", "アカウント作成")}</div></form>`}<details><summary>初回の同期先設定</summary><p>同梱のSYNC_SETUP.mdに従って同期先を作成し、両端末に同じ設定を入力してください。</p><label class="km-label">Supabase Project URL<input id="km-url" type="url" placeholder="https://….supabase.co" value="${esc(cfg?.url || "")}"></label><label class="km-label">公開用キー（Publishable / anon）<input id="km-key" type="password" autocomplete="off" value="${esc(cfg?.key || "")}"></label>${button("config", "接続先を保存")}<p>秘密キー・service_roleキーは入力しないでください。</p></details></section><section class="km-panel" id="kt-conflict-panel"><h2>KTの変更確認</h2><div id="kt-conflicts"></div>${button("kt-before", "初回同期前のKT記録を書き出す")}${button("kt-history", "変更確認の履歴を書き出す")}</section><section class="km-panel"><h2>自作カードのファイル保存・移行（両科目）</h2><p>数学・経済の両方の自作カードを、画像と復習履歴を含めて保存します。自動同期の未設定時も、別端末へ移せます。</p><div class="km-row">${button("export", "バックアップを書き出す")}<label class="km-file">読み込む<input id="km-import" type="file" accept="application/json,.json"></label></div><p>既存のKT科目の進捗は、従来のバックアップ機能をご利用ください。</p></section>${button("home", "← カード一覧")}`;
    renderKTConflicts();
    main.scrollTop = 0;
  }
  async function request(cfg, path, body, token) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(cfg.url + path, {
        method: "POST",
        headers: {
          apikey: cfg.key,
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: "no-store",
      });
      const v = await r.json();
      if (!r.ok)
        throw new Error(
          v.msg ||
            v.message ||
            v.error_description ||
            v.error ||
            "接続に失敗しました",
        );
      return v;
    } finally {
      clearTimeout(timeout);
    }
  }
  async function login(signup) {
    const cfg = await getMeta("config");
    if (!cfg) throw new Error("先に同期先を設定してください。");
    const form = root.querySelector("#km-auth");
    if (!form.reportValidity()) return;
    const email = root.querySelector("#km-email").value.trim(),
      password = root.querySelector("#km-password").value;
    const auth = await request(
      cfg,
      signup ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password",
      { email, password },
    );
    root.querySelector("#km-password").value = "";
    if (!auth.access_token) {
      notice("確認メールをご確認後、ログインしてください。");
      return;
    }
    const owner = await getMeta("owner");
    if (owner && owner !== auth.user.id)
      throw new Error(
        "この端末のカードは別アカウントに接続済みです。以前のアカウントでログインしてください。",
      );
    auth.expires_at = Date.now() + auth.expires_in * 1000;
    await setMeta("auth", auth);
    await setMeta("owner", auth.user.id);
    await settings();
    await sync();
  }
  async function sync() {
    if (syncBusy) return;
    syncBusy = true;
    try {
      if (navigator.locks)
        await navigator.locks.request("kt-quiz-sync-v52", performSync);
      else await performSync();
    } finally {
      syncBusy = false;
    }
  }
  async function performSync() {
    const cfg = await getMeta("config");
    let auth = await getMeta("auth");
    if (!cfg || !auth) {
      message = "";
      await status();
      return;
    }
    if (!navigator.onLine) {
      message = "オフライン · 端末に保存済み。接続後に同期します";
      await status();
      return;
    }
    message = "同期しています…";
    await status();
    try {
      if (auth.expires_at < Date.now() + 60000) {
        auth = await request(cfg, "/auth/v1/token?grant_type=refresh_token", {
          refresh_token: auth.refresh_token,
        });
        auth.expires_at = Date.now() + auth.expires_in * 1000;
        await setMeta("auth", auth);
      }
      const before = await getAll();
      const dirty = before.filter((c) => c.dirty);
      let batch = [],
        bytes = 0;
      for (const c of dirty) {
        const n = JSON.stringify(c).length;
        if (batch.length && bytes + n > 16 * 1024 * 1024) break;
        batch.push(c);
        bytes += n;
      }
      const reply = await request(
        cfg,
        "/rest/v1/rpc/kt_math_sync_v1",
        {
          batch: batch.map((c) => ({
            id: c.id,
            base: c.rev || 0,
            body: { ...c, dirty: undefined, rev: undefined },
          })),
        },
        auth.access_token,
      );
      if (!Array.isArray(reply.rows) || !Array.isArray(reply.conflicts))
        throw new Error(
          "同期先の応答が正しくありません。設定を確認してください。",
        );
      const conflicts = new Set(reply.conflicts);
      let conflictCount = 0;
      await transaction("cards", "readwrite", (store) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const local = new Map(req.result.map((c) => [c.id, c]));
          for (const row of reply.rows) {
            const remote = {
              ...row.body,
              id: row.id,
              rev: row.revision,
              dirty: false,
            };
            if (!validCard(remote)) {
              store.transaction.abort();
              return;
            }
            const current = local.get(row.id),
              sent = batch.find((c) => c.id === row.id);
            if (conflicts.has(row.id) && current?.dirty) {
              const copy = {
                ...current,
                id: uid(),
                rev: 0,
                dirty: true,
                mutation: uid(),
                deleted: false,
                draft: current.deleted ? true : current.draft,
                conflict: true,
                updatedAt: new Date().toISOString(),
              };
              store.put(copy);
              store.put(remote);
              conflictCount++;
            } else if (current?.dirty) {
              if (sent && current.mutation === sent.mutation) store.put(remote);
              else if (sent) store.put({ ...current, rev: row.revision });
            } else store.put(remote);
          }
        };
      });
      const ktResult = window.KT_SYNC
        ? await window.KT_SYNC.sync(request, cfg, auth)
        : { pending: 0, conflicts: 0 };
      await refresh();
      const left = cards.filter((c) => c.dirty).length + ktResult.pending;
      message = ktResult.conflicts
        ? `KTの変更確認が ${ktResult.conflicts}件あります（同期設定から確認）`
        : left
          ? `端末に保存済み · 同期待ち ${left}件`
          : `同期済み · ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
      if (conflictCount)
        notice(
          "別端末の変更と重なったカードは、両方残しました。一覧で確認してください。",
        );
      if (left) requestSync();
      if (root.querySelector("#kt-conflicts")) renderKTConflicts();
      if (root.querySelector("#km-list")) renderList();
    } catch (e) {
      message = "端末に保存済み · 同期できませんでした";
      notice(
        "同期エラー：" +
          (e.name === "AbortError"
            ? "時間がかかっています。後ほど「今すぐ同期」を押してください。"
            : e.message),
      );
    } finally {
      await status();
    }
  }
  root.addEventListener("input", (e) => {
    if (editor && e.target.closest("#km-form")) changed = true;
    if (e.target.id === "km-search") {
      query = e.target.value;
      renderList();
    }
  });
  root.addEventListener(
    "change",
    guard(async (e) => {
      if (e.target.dataset.file) {
        await addImages([...e.target.files], e.target.dataset.file);
        e.target.value = "";
      }
      if (e.target.id === "km-filter") {
        filter = e.target.value;
        renderList();
      }
      if (e.target.id === "km-import") await importFile(e.target.files[0]);
    }),
  );
  root.addEventListener("focusin", (e) => {
    const b = e.target.closest("[data-side]");
    if (b) pasteSide = b.dataset.side;
    if (e.target.id === "km-question") pasteSide = "q";
    if (e.target.id === "km-answer") pasteSide = "a";
  });
  root.addEventListener(
    "paste",
    guard(async (e) => {
      if (!editor) return;
      const files = [...e.clipboardData.items]
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile());
      if (files.length) {
        e.preventDefault();
        await addImages(files, pasteSide);
      }
    }),
  );
  root.addEventListener("dragover", (e) => {
    if (e.target.closest("[data-side]")) e.preventDefault();
  });
  root.addEventListener(
    "drop",
    guard(async (e) => {
      const box = e.target.closest("[data-side]");
      if (box && editor) {
        e.preventDefault();
        await addImages([...e.dataTransfer.files], box.dataset.side);
      }
    }),
  );
  root.addEventListener("submit", (e) => e.preventDefault());
  root.addEventListener(
    "click",
    guard(async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.ktChoice) {
        window.KT_SYNC.resolve(b.dataset.ktKey, b.dataset.ktChoice);
        renderKTConflicts();
        return;
      }
      if (b.dataset.edit) return edit(b.dataset.edit);
      if (b.dataset.zoom) {
        const [s, i] = b.dataset.zoom.split(":");
        return zoom(editor[s + "Images"][i]);
      }
      if (b.dataset.studyzoom) {
        const [s, i] = b.dataset.studyzoom.split(":");
        return zoom(
          cards.find((c) => c.id === queue[position])[s + "Images"][i],
        );
      }
      if (b.dataset.crop) {
        const [s, i] = b.dataset.crop.split(":");
        return crop(s, Number(i));
      }
      if (b.dataset.remove) {
        const [s, i] = b.dataset.remove.split(":");
        editor[s + "Images"].splice(Number(i), 1);
        changed = true;
        drawImages(s);
        return;
      }
      const a = b.dataset.action;
      if (!a) return;
      if (a === "close") return close();
      if (a === "home") {
        if (leaveEditor()) return home();
        return;
      }
      if (a === "new") return edit();
      if (a === "save" || a === "draft") return saveEditor(a === "draft");
      if (a === "settings") return settings();
      if (["due", "study", "fresh"].includes(a)) return start(a);
      if (a === "one") {
        start.cardId = editor.id;
        return start("one");
      }
      if (a === "delete") {
        if (confirm("このカードを削除しますか？")) {
          editor.deleted = true;
          await saveCard(editor);
          changed = false;
          await home();
        }
        return;
      }
      if (a === "reveal") {
        revealed = true;
        root.querySelector("#km-answer-panel").hidden = false;
        root.querySelector("#km-reveal").hidden = true;
        root.querySelector("#km-rating").hidden = false;
        return;
      }
      if (a.startsWith("rate-")) return rate(a.slice(5));
      if (a === "kt-history") return window.KT_SYNC?.downloadConflicts();
      if (a === "kt-before") return window.KT_SYNC?.downloadBackup();
      if (a === "export") return exportFile();
      if (a === "login" || a === "signup") return login(a === "signup");
      if (a === "sync") return sync();
      if (a === "logout") {
        if (syncBusy) throw new Error("同期の終了をお待ちください。");
        await setMeta("auth", null);
        message = "";
        await status();
        return settings();
      }
      if (a === "config") {
        const url = root
            .querySelector("#km-url")
            .value.trim()
            .replace(/\/$/, ""),
          key = root.querySelector("#km-key").value.trim();
        if (await getMeta("owner")) {
          const prev = await getMeta("config");
          if (prev?.url !== url)
            throw new Error(
              "この端末は同期先に接続済みです。同じ接続先をご利用ください。",
            );
        }
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key)
          throw new Error(
            "SupabaseのHTTPS URLと公開用キーを入力してください。",
          );
        if (key.startsWith("sb_secret_"))
          throw new Error("秘密キーは利用できません。");
        if (key.startsWith("eyJ")) {
          try {
            const payload = JSON.parse(
              atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
            );
            if (payload.role !== "anon") throw new Error();
          } catch {
            throw new Error("anonキーを入力してください。");
          }
        }
        await setMeta("config", { url, key });
        await settings();
        notice("同期先を保存しました。ログインしてください。");
      }
    }),
  );
  window.addEventListener("online", () => guard(sync)());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden)
      guard(async () => {
        await refresh();
        if (!editor && root.querySelector("#km-list")) renderList();
        await sync();
      })();
  });
  const target =
    document.getElementById("homeView") ||
    document.getElementById("mathPreview") ||
    document.body;
  const entries = document.createElement("div");
  entries.className = "km-entries";
  target.prepend(entries);
  const openers = {};
  for (const key of ["economy", "math"]) {
    const opener = document.createElement("button");
    opener.className = "km-entry";
    opener.type = "button";
    opener.dataset.subject = key;
    opener.innerHTML = `<span>${esc(subjects[key].label)}</span><strong>自分のカードで一問一答</strong><small>問い・答え・間違えた理由を登録 →</small>`;
    opener.onclick = guard(async () => {
      if (!leaveEditor()) return;
      subject = key;
      filter = "すべて";
      query = "";
      if (!root.open) root.showModal();
      await home();
      requestSync();
    });
    entries.append(opener);
    openers[key] = opener;
  }
  window.KT_MATH = { open: () => openers.math.click() };
  window.KT_CUSTOM = { open: (key = "economy") => openers[key]?.click() };
  const syncButton = document.createElement("button");
  syncButton.id = "ktSyncButton";
  syncButton.className = "secondary";
  syncButton.style.cssText = "width:100%;margin:0 0 18px;font-size:12px";
  syncButton.textContent = "KT・自作カードの同期設定";
  entries.after(syncButton);
  syncButton.onclick = guard(async () => {
    if (!root.open) root.showModal();
    await settings();
  });
  window.addEventListener("kt-sync-pending", () => {
    requestSync();
    guard(status)();
  });
  window.addEventListener("kt-sync-warning", (e) => notice(e.detail));
  // Pull updates while the app is visible, including when studying KT.
  setInterval(() => {
    if (!document.hidden) guard(sync)();
  }, 30000);
  requestSync();
  dbPromise.catch(() => {
    for (const opener of Object.values(openers)) {
      opener.disabled = true;
      opener.textContent =
        "自作カードの保存領域を開けません。ブラウザの保存設定をご確認ください。";
    }
  });
})();
