import {
  canonicalizeForDedupe,
  csvEscape,
  dedupeUrls,
  domainOf,
  formatBytes,
  formatDuration,
  parseInputCandidates
} from "./utils.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const MAX_URLS = 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const safeHttpUrl = value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};

class LinkPulseApp {
  constructor() {
    this.items = [];
    this.itemMap = new Map();
    this.filteredItems = [];
    this.selected = new Set();
    this.page = 1;
    this.isRunning = false;
    this.runController = null;
    this.currentRunKeys = new Set();
    this.currentStats = null;
    this.runStartedAt = 0;
    this.renderTimer = null;
    this.inputTimer = null;
    this.toastTimer = null;
    this.lastLiveAnnouncement = 0;
    this.numberFormat = new Intl.NumberFormat("ru-RU");

    this.nodes = {
      html: document.documentElement,
      urlInput: $("#urlInput"),
      inputCount: $("#inputCount"),
      pasteButton: $("#pasteButton"),
      fileInput: $("#fileInput"),
      clearInputButton: $("#clearInputButton"),
      dropZone: $("#dropZone"),
      patternInput: $("#patternInput"),
      rangeStart: $("#rangeStart"),
      rangeEnd: $("#rangeEnd"),
      rangeStep: $("#rangeStep"),
      rangePad: $("#rangePad"),
      letterCodes: $("#letterCodes"),
      generatorLimit: $("#generatorLimit"),
      generateButton: $("#generateButton"),
      concurrencySelect: $("#concurrencySelect"),
      useCacheCheckbox: $("#useCacheCheckbox"),
      historyCheckbox: $("#historyCheckbox"),
      validationMessage: $("#validationMessage"),
      startButton: $("#startButton"),
      progressCard: $("#progressCard"),
      progressTitle: $("#progressTitle"),
      progressSubtitle: $("#progressSubtitle"),
      progressTrack: $("#progressTrack"),
      progressPercent: $("#progressPercent"),
      progressCount: $("#progressCount"),
      progressSpeed: $("#progressSpeed"),
      progressEta: $("#progressEta"),
      progressSuccess: $("#progressSuccess"),
      progressRedirects: $("#progressRedirects"),
      progressErrors: $("#progressErrors"),
      progressRemaining: $("#progressRemaining"),
      stopButton: $("#stopButton"),
      resultsSection: $("#resultsSection"),
      resultsSubtitle: $("#resultsSubtitle"),
      summaryPills: $("#summaryPills"),
      searchInput: $("#searchInput"),
      categoryFilter: $("#categoryFilter"),
      domainFilter: $("#domainFilter"),
      latencyFilter: $("#latencyFilter"),
      sortSelect: $("#sortSelect"),
      resetFiltersButton: $("#resetFiltersButton"),
      selectVisibleCheckbox: $("#selectVisibleCheckbox"),
      selectedCount: $("#selectedCount"),
      recheckSelectedButton: $("#recheckSelectedButton"),
      recheckErrorsButton: $("#recheckErrorsButton"),
      copySelectedButton: $("#copySelectedButton"),
      newRunSelectedButton: $("#newRunSelectedButton"),
      deleteSelectedButton: $("#deleteSelectedButton"),
      exportButton: $("#exportButton"),
      emptyState: $("#emptyState"),
      resultsContent: $("#resultsContent"),
      filteredEmptyState: $("#filteredEmptyState"),
      clearFilteredEmptyButton: $("#clearFilteredEmptyButton"),
      resultsTableBody: $("#resultsTableBody"),
      mobileResults: $("#mobileResults"),
      rangeLabel: $("#rangeLabel"),
      pageSizeSelect: $("#pageSizeSelect"),
      previousPageButton: $("#previousPageButton"),
      nextPageButton: $("#nextPageButton"),
      pageLabel: $("#pageLabel"),
      backToInputButton: $("#backToInputButton"),
      historyCard: $("#historyCard"),
      historyList: $("#historyList"),
      clearHistoryButton: $("#clearHistoryButton"),
      detailsDialog: $("#detailsDialog"),
      detailsTitle: $("#detailsTitle"),
      detailsContent: $("#detailsContent"),
      exportDialog: $("#exportDialog"),
      helpDialog: $("#helpDialog"),
      helpButton: $("#helpButton"),
      themeButton: $("#themeButton"),
      toast: $("#toast"),
      liveRegion: $("#liveRegion")
    };

    this.restoreSettings();
    this.bindEvents();
    this.updateInputCount();
    this.renderHistory();
    this.renderResults();
  }

  bindEvents() {
    this.nodes.urlInput.addEventListener("input", () => {
      clearTimeout(this.inputTimer);
      this.inputTimer = setTimeout(() => this.updateInputCount(), 120);
    });
    this.nodes.pasteButton.addEventListener("click", () => this.pasteFromClipboard());
    this.nodes.fileInput.addEventListener("change", event => this.importFile(event.target.files?.[0]));
    this.nodes.clearInputButton.addEventListener("click", () => {
      this.nodes.urlInput.value = "";
      this.updateInputCount();
      this.nodes.urlInput.focus();
    });
    this.nodes.dropZone.addEventListener("click", () => this.nodes.fileInput.click());
    this.nodes.dropZone.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.nodes.fileInput.click();
      }
    });
    for (const name of ["dragenter", "dragover"]) {
      this.nodes.dropZone.addEventListener(name, event => {
        event.preventDefault();
        this.nodes.dropZone.classList.add("dragging");
      });
    }
    for (const name of ["dragleave", "drop"]) {
      this.nodes.dropZone.addEventListener(name, event => {
        event.preventDefault();
        this.nodes.dropZone.classList.remove("dragging");
      });
    }
    this.nodes.dropZone.addEventListener("drop", event => this.importFile(event.dataTransfer?.files?.[0]));
    this.nodes.generateButton.addEventListener("click", () => this.generateUrls());
    this.nodes.startButton.addEventListener("click", () => this.startInitialCheck());
    this.nodes.stopButton.addEventListener("click", () => this.stopCheck());

    for (const node of [this.nodes.searchInput, this.nodes.domainFilter]) {
      node.addEventListener("input", () => { this.page = 1; this.renderResults(); });
    }
    for (const node of [this.nodes.categoryFilter, this.nodes.latencyFilter, this.nodes.sortSelect, this.nodes.pageSizeSelect]) {
      node.addEventListener("change", () => { this.page = 1; this.renderResults(); });
    }
    this.nodes.resetFiltersButton.addEventListener("click", () => this.resetFilters());
    this.nodes.clearFilteredEmptyButton.addEventListener("click", () => this.resetFilters());
    this.nodes.selectVisibleCheckbox.addEventListener("change", () => this.toggleVisibleSelection());
    this.nodes.previousPageButton.addEventListener("click", () => { this.page = Math.max(1, this.page - 1); this.renderResults(); });
    this.nodes.nextPageButton.addEventListener("click", () => { this.page = Math.min(this.totalPages, this.page + 1); this.renderResults(); });
    this.nodes.recheckSelectedButton.addEventListener("click", () => this.recheckSelected());
    this.nodes.recheckErrorsButton.addEventListener("click", () => this.recheckErrors());
    this.nodes.copySelectedButton.addEventListener("click", () => this.copySelected());
    this.nodes.newRunSelectedButton.addEventListener("click", () => this.moveSelectedToNewRun());
    this.nodes.deleteSelectedButton.addEventListener("click", () => this.deleteSelected());
    this.nodes.exportButton.addEventListener("click", () => this.nodes.exportDialog.showModal());
    this.nodes.backToInputButton.addEventListener("click", () => this.nodes.urlInput.scrollIntoView({ behavior: "smooth", block: "center" }));

    this.nodes.resultsTableBody.addEventListener("click", event => this.handleResultAction(event));
    this.nodes.mobileResults.addEventListener("click", event => this.handleResultAction(event));
    this.nodes.resultsTableBody.addEventListener("change", event => this.handleSelectionChange(event));
    this.nodes.mobileResults.addEventListener("change", event => this.handleSelectionChange(event));

    this.nodes.themeButton.addEventListener("click", () => this.toggleTheme());
    this.nodes.helpButton.addEventListener("click", () => this.nodes.helpDialog.showModal());
    $$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => {
      document.getElementById(button.dataset.closeDialog)?.close();
    }));
    this.nodes.exportDialog.addEventListener("click", event => {
      const button = event.target.closest("[data-export-format]");
      if (button) this.exportResults(button.dataset.exportFormat);
    });
    this.nodes.historyList.addEventListener("click", event => {
      const button = event.target.closest("[data-history-run]");
      if (button) this.rerunHistory(button.dataset.historyRun);
    });
    this.nodes.clearHistoryButton.addEventListener("click", () => {
      localStorage.removeItem("linkpulse-history-v1");
      this.renderHistory();
      this.toast("Локальная история очищена.");
    });

    for (const node of [this.nodes.concurrencySelect, this.nodes.useCacheCheckbox, this.nodes.historyCheckbox, ...$$('input[name="mode"]')]) {
      node.addEventListener("change", () => this.saveSettings());
    }
  }

  get mode() {
    return $('input[name="mode"]:checked')?.value === "full" ? "full" : "quick";
  }

  get pageSize() {
    return Number(this.nodes.pageSizeSelect.value) || 50;
  }

  get totalPages() {
    return Math.max(1, Math.ceil(this.filteredItems.length / this.pageSize));
  }

  get inputEntries() {
    return dedupeUrls(parseInputCandidates(this.nodes.urlInput.value));
  }

  updateInputCount() {
    const raw = parseInputCandidates(this.nodes.urlInput.value);
    const unique = dedupeUrls(raw);
    const duplicates = Math.max(0, raw.length - unique.length);
    this.nodes.inputCount.textContent = `${this.format(unique.length)} уникальных URL${duplicates ? ` · ${this.format(duplicates)} дубликат(а/ов)` : ""}`;
    this.nodes.validationMessage.textContent = unique.length > MAX_URLS ? `Лимит одного запуска — ${this.format(MAX_URLS)} URL.` : "";
  }

  async pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return this.toast("Буфер обмена пуст.");
      this.appendInput(text);
      this.toast("Ссылки вставлены.");
    } catch {
      this.nodes.urlInput.focus();
      this.toast("Разрешите доступ к буферу или вставьте текст вручную.");
    }
  }

  async importFile(file) {
    this.nodes.fileInput.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return this.toast("Файл больше 5 МБ.");
    if (!/\.(txt|csv|xml)$/i.test(file.name)) return this.toast("Поддерживаются TXT, CSV и XML.");

    try {
      const text = await file.text();
      const urls = await this.parseFileInWorker(text);
      if (!urls.length) return this.toast("В файле не найдено URL.");
      this.appendInput(urls.join("\n"));
      this.toast(`Импортировано URL: ${this.format(urls.length)}.`);
    } catch (error) {
      this.toast(error?.message || "Не удалось прочитать файл.");
    }
  }

  parseFileInWorker(text) {
    if (!window.Worker) return Promise.resolve(parseInputCandidates(text));
    return new Promise((resolve, reject) => {
      const worker = new Worker("/assets/import-worker.js");
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Разбор файла занял слишком много времени."));
      }, 10000);
      worker.onmessage = event => {
        clearTimeout(timer);
        worker.terminate();
        resolve(event.data?.urls || []);
      };
      worker.onerror = () => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error("Ошибка разбора файла."));
      };
      worker.postMessage({ text });
    });
  }

  appendInput(text) {
    const current = this.nodes.urlInput.value.trim();
    this.nodes.urlInput.value = current ? `${current}\n${String(text).trim()}` : String(text).trim();
    this.updateInputCount();
  }

  generateUrls() {
    const pattern = this.nodes.patternInput.value.trim();
    if (!pattern.includes("{num}") || !pattern.includes("{letters}")) {
      return this.toast("Шаблон должен содержать {num} и {letters}.");
    }
    const start = Number(this.nodes.rangeStart.value);
    const end = Number(this.nodes.rangeEnd.value);
    const step = Math.max(1, Number(this.nodes.rangeStep.value) || 1);
    const pad = Number(this.nodes.rangePad.value) || 0;
    const limit = Math.min(10000, Math.max(1, Number(this.nodes.generatorLimit.value) || 1));
    const codes = [...new Set(this.nodes.letterCodes.value.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))];
    if (!Number.isFinite(start) || !Number.isFinite(end) || !codes.length) return this.toast("Проверьте диапазон и буквенные коды.");

    const direction = start <= end ? 1 : -1;
    const urls = [];
    for (let number = start; direction > 0 ? number <= end : number >= end; number += step * direction) {
      for (const code of codes) {
        urls.push(pattern.replaceAll("{num}", String(number).padStart(pad, "0")).replaceAll("{letters}", code));
        if (urls.length >= limit) break;
      }
      if (urls.length >= limit) break;
    }
    this.appendInput(urls.join("\n"));
    this.toast(`Создано URL: ${this.format(urls.length)}.`);
  }

  startInitialCheck() {
    const entries = this.inputEntries;
    this.nodes.validationMessage.textContent = "";
    if (!entries.length) {
      this.nodes.validationMessage.textContent = "Добавьте хотя бы один URL.";
      this.nodes.urlInput.focus();
      return;
    }
    if (entries.length > MAX_URLS) {
      this.nodes.validationMessage.textContent = `За один запуск можно проверить не более ${this.format(MAX_URLS)} URL.`;
      return;
    }

    this.items = entries.map((entry, index) => ({
      id: index + 1,
      key: entry.key,
      originalUrl: entry.url,
      normalizedUrl: entry.key,
      occurrences: entry.occurrences,
      category: "pending",
      label: "Ожидает",
      ok: false,
      status: null,
      latency: null,
      diagnostic: "Ожидает проверки."
    }));
    this.selected.clear();
    this.rebuildItemMap();
    this.page = 1;
    this.runCheck(entries.map(entry => entry.url), { force: !this.nodes.useCacheCheckbox.checked, merge: false });
  }

  async runCheck(urls, { force = false, merge = true } = {}) {
    if (this.isRunning || !urls.length) return;
    this.isRunning = true;
    this.runController = new AbortController();
    this.runStartedAt = performance.now();
    this.currentRunKeys = new Set(urls.map(canonicalizeForDedupe));
    this.currentStats = { total: urls.length, checked: 0, success: 0, redirects: 0, errors: 0, remaining: urls.length, speed: 0, etaSeconds: null };

    for (const key of this.currentRunKeys) {
      const item = this.itemMap.get(key);
      if (item) Object.assign(item, { category: "checking", label: "Проверяется", diagnostic: "Запрос добавлен в очередь." });
    }

    this.nodes.startButton.disabled = true;
    this.nodes.stopButton.disabled = false;
    this.nodes.progressCard.hidden = false;
    this.nodes.resultsSection.setAttribute("aria-busy", "true");
    this.nodes.progressTitle.textContent = "Проверка выполняется";
    this.nodes.progressSubtitle.textContent = `Режим: ${this.mode === "full" ? "полный" : "быстрый"}. Результаты поступают в реальном времени.`;
    this.updateProgress(this.currentStats);
    this.renderResults();
    this.nodes.progressCard.scrollIntoView({ behavior: "smooth", block: "start" });

    try {
      const response = await fetch("/api/check-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: this.runController.signal,
        body: JSON.stringify({
          urls,
          mode: this.mode,
          concurrency: Number(this.nodes.concurrencySelect.value),
          force
        })
      });

      if (!response.ok) {
        let payload = {};
        try { payload = await response.json(); } catch {}
        throw new Error(payload.error || `API вернул HTTP ${response.status}.`);
      }
      if (!response.body) throw new Error("Браузер не поддерживает потоковый ответ.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleStreamEvent(JSON.parse(line));
        }
        if (done) break;
      }
      if (buffer.trim()) this.handleStreamEvent(JSON.parse(buffer));

      if (this.isRunning) this.finishRun("done");
    } catch (error) {
      if (error?.name === "AbortError") {
        this.finishRun("cancelled");
      } else {
        this.finishRun("error", error?.message || "Проверка завершилась ошибкой.");
      }
    }
  }

  handleStreamEvent(event) {
    if (event.type === "start") {
      this.currentStats = event.stats;
      this.updateProgress(event.stats);
      return;
    }
    if (event.type === "result") {
      const key = canonicalizeForDedupe(event.result?.normalizedUrl || event.entry?.normalizedUrl || event.entry?.originalUrl);
      let item = this.itemMap.get(key);
      if (!item) {
        item = this.items.find(candidate => candidate.originalUrl === event.entry?.originalUrl);
      }
      if (item) {
        const oldKey = item.key;
        Object.assign(item, event.result, {
          key,
          occurrences: event.entry?.occurrences || item.occurrences || 1
        });
        if (oldKey !== key) {
          this.itemMap.delete(oldKey);
          this.itemMap.set(key, item);
        }
      }
      this.currentStats = event.stats;
      this.updateProgress(event.stats);
      this.scheduleRender();
      return;
    }
    if (event.type === "done") {
      this.currentStats = event.stats;
      this.updateProgress(event.stats);
    }
    if (event.type === "error") throw new Error(event.error || "Ошибка потока.");
  }

  finishRun(state, message = "") {
    if (!this.isRunning) return;
    const durationMs = performance.now() - this.runStartedAt;
    this.isRunning = false;
    this.nodes.startButton.disabled = false;
    this.nodes.stopButton.disabled = true;
    this.nodes.resultsSection.setAttribute("aria-busy", "false");
    this.runController = null;

    if (state === "cancelled") {
      for (const key of this.currentRunKeys) {
        const item = this.itemMap.get(key);
        if (item && ["pending", "checking"].includes(item.category)) {
          Object.assign(item, { category: "cancelled", label: "Отменено", diagnostic: "Проверка остановлена пользователем." });
        }
      }
      this.nodes.progressTitle.textContent = "Проверка остановлена";
      this.nodes.progressSubtitle.textContent = "Полученные результаты сохранены. Незавершённые URL можно перепроверить.";
      this.toast("Проверка остановлена.");
    } else if (state === "error") {
      for (const key of this.currentRunKeys) {
        const item = this.itemMap.get(key);
        if (item && ["pending", "checking"].includes(item.category)) {
          Object.assign(item, { category: "network_error", label: "Ошибка API", diagnostic: message });
        }
      }
      this.nodes.progressTitle.textContent = "Не удалось завершить проверку";
      this.nodes.progressSubtitle.textContent = message;
      this.toast(message);
    } else {
      this.nodes.progressTitle.textContent = "Проверка завершена";
      this.nodes.progressSubtitle.textContent = `Готово за ${formatDuration(durationMs)}.`;
      this.toast("Проверка завершена.");
      this.saveHistory(durationMs);
    }

    this.currentRunKeys.clear();
    this.renderResults();
  }

  stopCheck() {
    if (!this.isRunning) return;
    this.runController?.abort();
  }

  updateProgress(stats = {}) {
    const total = Number(stats.total) || 0;
    const checked = Number(stats.checked) || 0;
    const percent = total ? Math.min(100, Math.round((checked / total) * 100)) : 0;
    this.nodes.progressTrack.value = percent;
    this.nodes.progressTrack.textContent = `${percent}%`;
    this.nodes.progressPercent.textContent = `${percent}%`;
    this.nodes.progressCount.textContent = `${this.format(checked)} из ${this.format(total)}`;
    this.nodes.progressSpeed.textContent = `${Number(stats.speed || 0).toFixed(1)} URL/с`;
    this.nodes.progressEta.textContent = `Осталось: ${Number.isFinite(stats.etaSeconds) ? formatDuration(stats.etaSeconds * 1000) : "—"}`;
    this.nodes.progressSuccess.textContent = this.format(stats.success || 0);
    this.nodes.progressRedirects.textContent = this.format(stats.redirects || 0);
    this.nodes.progressErrors.textContent = this.format(stats.errors || 0);
    this.nodes.progressRemaining.textContent = this.format(stats.remaining ?? Math.max(0, total - checked));

    const now = Date.now();
    if (now - this.lastLiveAnnouncement > 3000 || checked === total) {
      this.nodes.liveRegion.textContent = `Проверено ${checked} из ${total}. Ошибок: ${stats.errors || 0}.`;
      this.lastLiveAnnouncement = now;
    }
  }

  scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderResults();
    }, 100);
  }

  applyFilters() {
    const search = this.nodes.searchInput.value.trim().toLowerCase();
    const category = this.nodes.categoryFilter.value;
    const domain = this.nodes.domainFilter.value.trim().toLowerCase();
    const latencyFloor = Number(this.nodes.latencyFilter.value) || 0;

    this.filteredItems = this.items.filter(item => {
      const itemDomain = domainOf(item.normalizedUrl || item.originalUrl).toLowerCase();
      const textMatch = !search || [item.originalUrl, item.normalizedUrl, item.finalUrl, item.label, item.diagnostic, item.status].join(" ").toLowerCase().includes(search);
      const domainMatch = !domain || itemDomain.includes(domain);
      const latencyMatch = !latencyFloor || Number(item.latency) >= latencyFloor;
      let categoryMatch = category === "all" || item.category === category;
      if (category === "problems") categoryMatch = !item.ok || ["slow", "cancelled"].includes(item.category);
      return textMatch && domainMatch && latencyMatch && categoryMatch;
    });

    const sort = this.nodes.sortSelect.value;
    const order = new Map(this.items.map((item, index) => [item.key, index]));
    this.filteredItems.sort((a, b) => {
      if (sort === "latency-desc") return (Number(b.latency) || -1) - (Number(a.latency) || -1);
      if (sort === "latency-asc") return (Number(a.latency) || Infinity) - (Number(b.latency) || Infinity);
      if (sort === "domain") return domainOf(a.normalizedUrl).localeCompare(domainOf(b.normalizedUrl), "ru");
      if (sort === "status") return `${a.category}:${a.status || 0}`.localeCompare(`${b.category}:${b.status || 0}`, "ru");
      return (order.get(a.key) || 0) - (order.get(b.key) || 0);
    });
  }

  renderResults() {
    this.applyFilters();
    this.page = Math.min(this.page, this.totalPages);
    const start = (this.page - 1) * this.pageSize;
    const visible = this.filteredItems.slice(start, start + this.pageSize);
    const completed = this.items.filter(item => !["pending", "checking"].includes(item.category));
    const working = completed.filter(item => item.ok && item.category !== "redirect").length;
    const redirects = completed.filter(item => item.category === "redirect").length;
    const errors = completed.filter(item => !item.ok).length;

    this.nodes.emptyState.hidden = this.items.length > 0;
    this.nodes.resultsContent.hidden = this.items.length === 0;
    this.nodes.filteredEmptyState.hidden = this.items.length === 0 || this.filteredItems.length > 0;
    this.nodes.resultsSubtitle.textContent = this.items.length
      ? `Показано ${this.format(this.filteredItems.length)} из ${this.format(this.items.length)}. Результаты обновляются пакетами без перегрузки интерфейса.`
      : "Добавьте ссылки и запустите проверку.";
    this.nodes.summaryPills.innerHTML = this.items.length ? [
      `<span class="summary-pill"><span class="status-symbol status-working">✓</span>${this.format(working)}</span>`,
      `<span class="summary-pill"><span class="status-symbol status-redirect">↪</span>${this.format(redirects)}</span>`,
      `<span class="summary-pill"><span class="status-symbol status-error">!</span>${this.format(errors)}</span>`
    ].join("") : "";

    this.nodes.resultsTableBody.innerHTML = visible.map(item => this.tableRowHtml(item)).join("");
    this.nodes.mobileResults.innerHTML = visible.map(item => this.mobileCardHtml(item)).join("");

    const end = Math.min(start + visible.length, this.filteredItems.length);
    this.nodes.rangeLabel.textContent = `${this.format(visible.length ? start + 1 : 0)}–${this.format(end)} из ${this.format(this.filteredItems.length)}`;
    this.nodes.pageLabel.textContent = `${this.page} / ${this.totalPages}`;
    this.nodes.previousPageButton.disabled = this.page <= 1;
    this.nodes.nextPageButton.disabled = this.page >= this.totalPages;

    const visibleSelected = visible.length > 0 && visible.every(item => this.selected.has(item.key));
    this.nodes.selectVisibleCheckbox.checked = visibleSelected;
    this.nodes.selectVisibleCheckbox.indeterminate = !visibleSelected && visible.some(item => this.selected.has(item.key));
    this.nodes.selectedCount.textContent = `Выбрано: ${this.format(this.selected.size)}`;
    this.nodes.recheckSelectedButton.disabled = this.isRunning || this.selected.size === 0;
    this.nodes.copySelectedButton.disabled = this.selected.size === 0;
    this.nodes.newRunSelectedButton.disabled = this.selected.size === 0;
    this.nodes.deleteSelectedButton.disabled = this.isRunning || this.selected.size === 0;
    this.nodes.exportButton.disabled = this.items.length === 0;
    this.nodes.recheckErrorsButton.disabled = this.isRunning || !this.items.some(item => !item.ok && !["pending", "checking"].includes(item.category));
  }

  tableRowHtml(item) {
    const href = safeHttpUrl(item.finalUrl || item.normalizedUrl || item.originalUrl);
    const checkedAt = item.checkedAt ? new Date(item.checkedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    const key = escapeHtml(item.key);
    return `<tr>
      <td class="select-cell"><input class="result-select" type="checkbox" data-key="${key}" aria-label="Выбрать ${escapeHtml(item.originalUrl)}" ${this.selected.has(item.key) ? "checked" : ""}></td>
      <td class="url-cell">${href ? `<a class="url-main" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(item.originalUrl)}">${escapeHtml(item.originalUrl)}</a>` : `<span class="url-main" title="${escapeHtml(item.originalUrl)}">${escapeHtml(item.originalUrl)}</span>`}<span class="url-meta"><span>${escapeHtml(domainOf(item.normalizedUrl || item.originalUrl) || "без домена")}</span>${item.occurrences > 1 ? `<span>×${item.occurrences}</span>` : ""}${item.cached ? `<span>кэш</span>` : ""}</span></td>
      <td><span class="status-badge category-${escapeHtml(item.category || "pending")}" title="${escapeHtml(item.diagnostic || "")}">${escapeHtml(item.label || "Ожидает")}</span></td>
      <td><span class="http-code">${item.status || "—"}</span></td>
      <td><span class="latency-code">${formatDuration(item.latency)}</span></td>
      <td>${checkedAt}</td>
      <td><div class="row-actions"><button class="icon-button" type="button" data-action="details" data-key="${key}" aria-label="Открыть детали">i</button><button class="icon-button" type="button" data-action="recheck" data-key="${key}" aria-label="Перепроверить">↻</button></div></td>
    </tr>`;
  }

  mobileCardHtml(item) {
    const href = safeHttpUrl(item.finalUrl || item.normalizedUrl || item.originalUrl);
    const key = escapeHtml(item.key);
    return `<article class="mobile-card">
      <div class="mobile-card-top">
        <input class="result-select" type="checkbox" data-key="${key}" aria-label="Выбрать ${escapeHtml(item.originalUrl)}" ${this.selected.has(item.key) ? "checked" : ""}>
        <div class="mobile-card-url">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.originalUrl)}</a>` : `<span>${escapeHtml(item.originalUrl)}</span>`}<small>${escapeHtml(domainOf(item.normalizedUrl || item.originalUrl) || "Некорректный URL")}</small></div>
        <span class="status-badge category-${escapeHtml(item.category || "pending")}">${escapeHtml(item.label || "Ожидает")}</span>
      </div>
      <div class="mobile-card-meta"><div><small>HTTP</small><b>${item.status || "—"}</b></div><div><small>Время</small><b>${formatDuration(item.latency)}</b></div><div><small>Редиректы</small><b>${item.redirectCount ?? "—"}</b></div></div>
      <div class="mobile-card-actions"><button class="button button-secondary" type="button" data-action="details" data-key="${key}">Детали</button><button class="button button-secondary" type="button" data-action="recheck" data-key="${key}">Перепроверить</button></div>
    </article>`;
  }

  handleResultAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const item = this.itemMap.get(button.dataset.key);
    if (!item) return;
    if (button.dataset.action === "details") this.openDetails(item);
    if (button.dataset.action === "recheck") this.runCheck([item.originalUrl], { force: true, merge: true });
  }

  handleSelectionChange(event) {
    const checkbox = event.target.closest(".result-select");
    if (!checkbox) return;
    if (checkbox.checked) this.selected.add(checkbox.dataset.key);
    else this.selected.delete(checkbox.dataset.key);
    this.renderResults();
  }

  toggleVisibleSelection() {
    const start = (this.page - 1) * this.pageSize;
    const visible = this.filteredItems.slice(start, start + this.pageSize);
    for (const item of visible) {
      if (this.nodes.selectVisibleCheckbox.checked) this.selected.add(item.key);
      else this.selected.delete(item.key);
    }
    this.renderResults();
  }

  openDetails(item) {
    this.nodes.detailsTitle.textContent = item.label || "Детали результата";
    const dl = document.createElement("dl");
    dl.className = "detail-grid";
    const pairs = [
      ["Исходный URL", item.originalUrl],
      ["Нормализованный", item.normalizedUrl],
      ["Категория", item.label],
      ["HTTP", item.status ? `${item.status} ${item.statusText || ""}`.trim() : "—"],
      ["Конечный URL", item.finalUrl || "—"],
      ["Время ответа", formatDuration(item.latency)],
      ["Метод", item.method || "—"],
      ["Тип контента", item.contentType || "—"],
      ["Размер", formatBytes(item.contentLength)],
      ["Повторные попытки", item.retries ?? "—"],
      ["Кэш", item.cached ? `Да, возраст ${formatDuration(item.cacheAgeMs)}` : "Нет"],
      ["Диагностика", item.diagnostic || "—"],
      ["TLS", item.tls ? `${item.tls.valid ? "действителен" : "ошибка"}${item.tls.validTo ? ` до ${new Date(item.tls.validTo).toLocaleDateString("ru-RU")}` : ""}` : "—"]
    ];
    for (const [term, value] of pairs) {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = term;
      dd.textContent = String(value ?? "—");
      dl.append(dt, dd);
    }
    this.nodes.detailsContent.replaceChildren(dl);
    if (item.redirectChain?.length) {
      const heading = document.createElement("h3");
      heading.textContent = "Цепочка редиректов";
      const list = document.createElement("ol");
      list.className = "redirect-list";
      for (const hop of item.redirectChain) {
        const li = document.createElement("li");
        li.textContent = `${hop.status}: ${hop.url} → ${hop.location}`;
        list.append(li);
      }
      this.nodes.detailsContent.append(heading, list);
    }
    this.nodes.detailsDialog.showModal();
  }

  recheckSelected() {
    const urls = this.items.filter(item => this.selected.has(item.key)).map(item => item.originalUrl);
    this.runCheck(urls, { force: true, merge: true });
  }

  recheckErrors() {
    const urls = this.items.filter(item => !item.ok && !["pending", "checking"].includes(item.category)).map(item => item.originalUrl);
    this.runCheck(urls, { force: true, merge: true });
  }

  async copySelected() {
    const urls = this.items.filter(item => this.selected.has(item.key)).map(item => item.originalUrl);
    if (!urls.length) return;
    try {
      await navigator.clipboard.writeText(urls.join("\n"));
      this.toast(`Скопировано URL: ${this.format(urls.length)}.`);
    } catch {
      this.toast("Не удалось скопировать URL.");
    }
  }

  moveSelectedToNewRun() {
    const urls = this.items.filter(item => this.selected.has(item.key)).map(item => item.originalUrl);
    if (!urls.length) return;
    this.nodes.urlInput.value = urls.join("\n");
    this.updateInputCount();
    this.nodes.urlInput.scrollIntoView({ behavior: "smooth", block: "center" });
    this.toast(`Подготовлен новый запуск: ${this.format(urls.length)} URL.`);
  }

  deleteSelected() {
    if (!this.selected.size || this.isRunning) return;
    const deleted = this.selected.size;
    this.items = this.items.filter(item => !this.selected.has(item.key));
    this.selected.clear();
    this.rebuildItemMap();
    this.page = 1;
    this.renderResults();
    this.toast(`Удалено строк: ${this.format(deleted)}.`);
  }

  exportResults(format) {
    const scope = $('input[name="exportScope"]:checked', this.nodes.exportDialog)?.value || "filtered";
    let rows;
    if (scope === "all") rows = this.items;
    else if (scope === "selected") rows = this.items.filter(item => this.selected.has(item.key));
    else if (scope === "errors") rows = this.items.filter(item => !item.ok || item.category === "slow");
    else rows = this.filteredItems;
    if (!rows.length) return this.toast("В выбранном наборе нет результатов.");

    if (format === "json") {
      this.download("linkpulse-results.json", JSON.stringify(rows, null, 2), "application/json;charset=utf-8");
    } else if (format === "txt") {
      this.download("linkpulse-urls.txt", rows.map(item => item.originalUrl).join("\n"), "text/plain;charset=utf-8");
    } else {
      const headers = ["url", "normalized_url", "category", "label", "http_status", "status_text", "final_url", "redirects", "latency_ms", "content_type", "content_length", "checked_at", "cached", "diagnostic"];
      const data = rows.map(item => [item.originalUrl, item.normalizedUrl, item.category, item.label, item.status, item.statusText, item.finalUrl, item.redirectCount, item.latency, item.contentType, item.contentLength, item.checkedAt, item.cached, item.diagnostic]);
      const csv = [headers, ...data].map(row => row.map(csvEscape).join(",")).join("\n");
      this.download("linkpulse-results.csv", `\ufeff${csv}`, "text/csv;charset=utf-8");
    }
    this.nodes.exportDialog.close();
    this.toast(`Экспортировано строк: ${this.format(rows.length)}.`);
  }

  download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  resetFilters() {
    this.nodes.searchInput.value = "";
    this.nodes.categoryFilter.value = "all";
    this.nodes.domainFilter.value = "";
    this.nodes.latencyFilter.value = "0";
    this.nodes.sortSelect.value = "original";
    this.page = 1;
    this.renderResults();
  }

  rebuildItemMap() {
    this.itemMap = new Map(this.items.map(item => [item.key, item]));
  }

  saveHistory(durationMs) {
    if (!this.nodes.historyCheckbox.checked) return;
    const now = Date.now();
    const counts = {
      total: this.items.length,
      working: this.items.filter(item => item.ok && item.category !== "redirect").length,
      redirects: this.items.filter(item => item.category === "redirect").length,
      errors: this.items.filter(item => !item.ok).length
    };
    const history = this.getHistory().filter(entry => now - entry.createdAt < 7 * 24 * 60 * 60 * 1000);
    history.unshift({
      id: crypto.randomUUID(),
      createdAt: now,
      durationMs: Math.round(durationMs),
      mode: this.mode,
      counts,
      urls: this.items.slice(0, MAX_URLS).map(item => item.originalUrl)
    });
    localStorage.setItem("linkpulse-history-v1", JSON.stringify(history.slice(0, 10)));
    this.renderHistory();
  }

  getHistory() {
    try {
      const value = JSON.parse(localStorage.getItem("linkpulse-history-v1") || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  renderHistory() {
    const history = this.getHistory().filter(entry => Date.now() - entry.createdAt < 7 * 24 * 60 * 60 * 1000);
    this.nodes.historyCard.hidden = history.length === 0;
    this.nodes.historyList.innerHTML = history.map(entry => `<article class="history-item"><div><strong>${new Date(entry.createdAt).toLocaleString("ru-RU")} · ${escapeHtml(entry.mode === "full" ? "полная" : "быстрая")} проверка</strong><p>${this.format(entry.counts.total)} URL · ${this.format(entry.counts.working)} работают · ${this.format(entry.counts.errors)} ошибок · ${formatDuration(entry.durationMs)}</p></div><button class="button button-secondary" type="button" data-history-run="${escapeHtml(entry.id)}">Запустить снова</button></article>`).join("");
  }

  rerunHistory(id) {
    const entry = this.getHistory().find(item => item.id === id);
    if (!entry?.urls?.length) return this.toast("Данные запуска не найдены.");
    this.nodes.urlInput.value = entry.urls.join("\n");
    this.updateInputCount();
    const modeNode = $(`input[name="mode"][value="${entry.mode}"]`);
    if (modeNode) modeNode.checked = true;
    this.startInitialCheck();
  }

  toggleTheme() {
    const next = this.nodes.html.dataset.theme === "dark" ? "light" : "dark";
    this.nodes.html.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#0d111a" : "#f4f6fa");
    this.saveSettings();
  }

  saveSettings() {
    localStorage.setItem("linkpulse-settings-v1", JSON.stringify({
      theme: this.nodes.html.dataset.theme,
      mode: this.mode,
      concurrency: this.nodes.concurrencySelect.value,
      useCache: this.nodes.useCacheCheckbox.checked,
      history: this.nodes.historyCheckbox.checked
    }));
  }

  restoreSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem("linkpulse-settings-v1") || "{}");
      const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      this.nodes.html.dataset.theme = settings.theme || (systemDark ? "dark" : "light");
      if (settings.mode) {
        const modeNode = $(`input[name="mode"][value="${settings.mode}"]`);
        if (modeNode) modeNode.checked = true;
      }
      if (["4", "8", "12", "16", "24"].includes(settings.concurrency)) this.nodes.concurrencySelect.value = settings.concurrency;
      if (typeof settings.useCache === "boolean") this.nodes.useCacheCheckbox.checked = settings.useCache;
      if (typeof settings.history === "boolean") this.nodes.historyCheckbox.checked = settings.history;
    } catch {}
  }

  toast(message) {
    this.nodes.toast.textContent = message;
    this.nodes.toast.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.nodes.toast.classList.remove("show"), 2800);
  }

  format(value) {
    return this.numberFormat.format(Number(value) || 0);
  }
}

new LinkPulseApp();
