"use client";

import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Gauge,
  History,
  Info,
  Keyboard,
  Link2,
  ListFilter,
  LoaderCircle,
  Moon,
  Palette,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UploadCloud,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type CheckMode = "quick" | "full";
type Theme = "dark" | "light";
type Wallpaper = "aurora" | "velvet" | "polar" | "studio";
type Accent = "mint" | "violet" | "cyan" | "amber";
type Density = "comfortable" | "compact";
type FilterCategory =
  | "all"
  | "problems"
  | "working"
  | "redirect"
  | "slow"
  | "errors";
type ExportScope = "filtered" | "all" | "selected" | "errors";

type RedirectHop = {
  status: number;
  url: string;
  location: string;
};

type ResultItem = {
  key: string;
  originalUrl: string;
  normalizedUrl: string;
  finalUrl?: string;
  occurrences: number;
  ok: boolean;
  category: string;
  label: string;
  status?: number | null;
  statusText?: string;
  latency?: number | null;
  method?: string;
  redirectCount?: number;
  redirectChain?: RedirectHop[];
  contentType?: string;
  contentLength?: number | null;
  checkedAt?: string;
  diagnostic: string;
  cached?: boolean;
  cacheAgeMs?: number;
};

type ProgressState = {
  total: number;
  checked: number;
  success: number;
  redirects: number;
  errors: number;
  cached: number;
  startedAt: number;
  speed: number;
  etaSeconds: number | null;
  state: "idle" | "running" | "done" | "stopped" | "error";
};

type Preferences = {
  theme: Theme;
  wallpaper: Wallpaper;
  accent: Accent;
  density: Density;
  glass: number;
  motion: boolean;
};

type HistoryEntry = {
  id: string;
  createdAt: number;
  durationMs: number;
  mode: CheckMode;
  counts: {
    total: number;
    working: number;
    redirects: number;
    errors: number;
  };
  urls: string[];
};

type StreamEvent = {
  type: "start" | "result" | "done" | "cancelled" | "error";
  result?: Partial<ResultItem>;
  entry?: {
    originalUrl: string;
    normalizedUrl: string;
    occurrences: number;
  };
  error?: string;
};

const MAX_URLS = 1_000;
const API_BATCH_SIZE = 100;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SETTINGS_KEY = "linkpulse-studio-settings-v1";
const HISTORY_KEY = "linkpulse-studio-history-v1";

const defaultPreferences: Preferences = {
  theme: "dark",
  wallpaper: "aurora",
  accent: "mint",
  density: "comfortable",
  glass: 72,
  motion: true,
};

const emptyProgress: ProgressState = {
  total: 0,
  checked: 0,
  success: 0,
  redirects: 0,
  errors: 0,
  cached: 0,
  startedAt: 0,
  speed: 0,
  etaSeconds: null,
  state: "idle",
};

const sampleUrls = [
  "https://example.com/",
  "https://example.com/about",
  "https://httpstat.us/301",
  "https://httpstat.us/404",
  "https://httpstat.us/500",
].join("\n");

const wallpaperOptions: Array<{
  id: Wallpaper;
  title: string;
  subtitle: string;
}> = [
  { id: "aurora", title: "Aurora Noir", subtitle: "Изумрудный свет" },
  { id: "velvet", title: "Velvet Dusk", subtitle: "Обсидиановый шёлк" },
  { id: "polar", title: "Polar Bloom", subtitle: "Ледяное стекло" },
  { id: "studio", title: "Quiet Studio", subtitle: "Чистый градиент" },
];

const accentOptions: Array<{ id: Accent; title: string; color: string }> = [
  { id: "mint", title: "Mint", color: "#74f2c1" },
  { id: "violet", title: "Violet", color: "#a78bfa" },
  { id: "cyan", title: "Cyan", color: "#55d7ff" },
  { id: "amber", title: "Amber", color: "#ffc66d" },
];

const filterOptions: Array<{ id: FilterCategory; label: string }> = [
  { id: "all", label: "Все" },
  { id: "problems", label: "Нужно внимание" },
  { id: "working", label: "Работают" },
  { id: "redirect", label: "Редиректы" },
  { id: "slow", label: "Медленные" },
  { id: "errors", label: "Ошибки" },
];

function decodeEntities(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function normalizeCandidate(value: string) {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (
    trimmed &&
    !/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) &&
    /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(trimmed)
  ) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function parseInputCandidates(text: string) {
  const source = String(text || "");
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeCandidate(value.replace(/[),.;\]}]+$/g, ""));
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    values.push(normalized);
  };

  const locPattern = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = locPattern.exec(source))) add(decodeEntities(match[1]));

  const urlPattern = /https?:\/\/[^\s<>"'`]+/gi;
  while ((match = urlPattern.exec(source))) add(match[0]);

  for (const line of source.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (!/[\s,;]/.test(candidate)) add(candidate);
  }

  return values;
}

function canonicalize(value: string) {
  const normalized = normalizeCandidate(value);
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol)) return normalized;
    url.hash = "";
    return url.toString();
  } catch {
    return normalized;
  }
}

function dedupeUrls(values: string[]) {
  const map = new Map<
    string,
    { url: string; key: string; occurrences: number; valid: boolean }
  >();
  for (const value of values) {
    const url = normalizeCandidate(value);
    if (!url) continue;
    const key = canonicalize(url);
    const existing = map.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = ["http:", "https:"].includes(parsed.protocol);
    } catch {
      valid = false;
    }
    map.set(key, { url, key, occurrences: 1, valid });
  }
  return [...map.values()];
}

function domainOf(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return "Некорректный адрес";
  }
}

function safeHref(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function formatDuration(ms?: number | null) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.max(0, Math.round(value))} мс`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} с`;
}

function formatBytes(bytes?: number | null) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1_024) return `${value} Б`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} КБ`;
  return `${(value / 1_024 ** 2).toFixed(1)} МБ`;
}

function csvEscape(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function statusTone(category: string) {
  if (category === "working") return "success";
  if (category === "redirect" || category === "slow") return "warning";
  if (category === "pending" || category === "checking") return "neutral";
  if (category === "cancelled") return "neutral";
  return "danger";
}

function resultIsComplete(result: ResultItem) {
  return !["pending", "checking"].includes(result.category);
}

function resultIsProblem(result: ResultItem) {
  return !result.ok || ["slow", "cancelled"].includes(result.category);
}

export default function Home() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<CheckMode>("quick");
  const [concurrency, setConcurrency] = useState(6);
  const [useCache, setUseCache] = useState(true);
  const [saveHistory, setSaveHistory] = useState(false);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(emptyProgress);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<FilterCategory>("all");
  const [sort, setSort] = useState("original");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [details, setDetails] = useState<ResultItem | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] =
    useState<ExportScope>("filtered");
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generatorPattern, setGeneratorPattern] = useState(
    "https://example.com/product-{num}-{letters}",
  );
  const [generatorStart, setGeneratorStart] = useState(1);
  const [generatorEnd, setGeneratorEnd] = useState(10);
  const [generatorCodes, setGeneratorCodes] = useState("a, b");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [preferences, setPreferences] =
    useState<Preferences>(defaultPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [toast, setToast] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [dragging, setDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputPanelRef = useRef<HTMLElement>(null);
  const progressRefEl = useRef<HTMLElement>(null);
  const resultsRef = useRef<ResultItem[]>([]);
  const progressRef = useRef<ProgressState>(emptyProgress);
  const controllerRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const numberFormat = useMemo(() => new Intl.NumberFormat("ru-RU"), []);

  const rawCandidates = useMemo(
    () => parseInputCandidates(input),
    [input],
  );
  const inputEntries = useMemo(
    () => dedupeUrls(rawCandidates),
    [rawCandidates],
  );
  const inputStats = useMemo(
    () => ({
      total: rawCandidates.length,
      unique: inputEntries.length,
      duplicates: Math.max(0, rawCandidates.length - inputEntries.length),
      invalid: inputEntries.filter((entry) => !entry.valid).length,
    }),
    [inputEntries, rawCandidates.length],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(""), 3_000);
  }, []);

  const commitResults = useCallback((next: ResultItem[]) => {
    resultsRef.current = next;
    setResults(next);
  }, []);

  const commitProgress = useCallback((next: ProgressState) => {
    progressRef.current = next;
    setProgress(next);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(
          localStorage.getItem(SETTINGS_KEY) || "{}",
        ) as Partial<Preferences> & {
          mode?: CheckMode;
          concurrency?: number;
          useCache?: boolean;
          saveHistory?: boolean;
        };
        setPreferences({
          ...defaultPreferences,
          ...stored,
          glass: Math.min(92, Math.max(36, Number(stored.glass) || 72)),
        });
        if (stored.mode === "full" || stored.mode === "quick") {
          setMode(stored.mode);
        }
        if ([3, 6, 9, 12].includes(Number(stored.concurrency))) {
          setConcurrency(Number(stored.concurrency));
        }
        if (typeof stored.useCache === "boolean") {
          setUseCache(stored.useCache);
        }
        if (typeof stored.saveHistory === "boolean") {
          setSaveHistory(stored.saveHistory);
        }
      } catch {
        // Corrupt local settings should never block the app.
      }

      try {
        const storedHistory = JSON.parse(
          localStorage.getItem(HISTORY_KEY) || "[]",
        ) as HistoryEntry[];
        const fresh = Array.isArray(storedHistory)
          ? storedHistory.filter(
              (entry) =>
                Date.now() - entry.createdAt < 7 * 24 * 60 * 60 * 1_000,
            )
          : [];
        setHistory(fresh.slice(0, 10));
      } catch {
        setHistory([]);
      }
      setPreferencesReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        ...preferences,
        mode,
        concurrency,
        useCache,
        saveHistory,
      }),
    );
    document.documentElement.style.colorScheme = preferences.theme;
  }, [
    concurrency,
    mode,
    preferences,
    preferencesReady,
    saveHistory,
    useCache,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (!running) {
          document
            .querySelector<HTMLButtonElement>("[data-primary-run]")
            ?.click();
        }
      }
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setHelpOpen(false);
        setDetails(null);
        setExportOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [running]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const completedResults = useMemo(
    () => results.filter(resultIsComplete),
    [results],
  );
  const summary = useMemo(
    () => ({
      total: results.length,
      working: completedResults.filter(
        (item) => item.ok && item.category !== "redirect",
      ).length,
      redirects: completedResults.filter(
        (item) => item.category === "redirect",
      ).length,
      errors: completedResults.filter((item) => !item.ok).length,
      slow: completedResults.filter((item) => item.category === "slow").length,
    }),
    [completedResults, results.length],
  );

  const filteredResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    const order = new Map(results.map((item, index) => [item.key, index]));
    const filtered = results.filter((item) => {
      const text = [
        item.originalUrl,
        item.normalizedUrl,
        item.finalUrl,
        item.label,
        item.status,
        item.diagnostic,
      ]
        .join(" ")
        .toLowerCase();
      if (query && !text.includes(query)) return false;
      if (category === "working") return item.category === "working";
      if (category === "redirect") return item.category === "redirect";
      if (category === "slow") return item.category === "slow";
      if (category === "errors") return resultIsComplete(item) && !item.ok;
      if (category === "problems") return resultIsProblem(item);
      return true;
    });

    return filtered.sort((a, b) => {
      if (sort === "latency-desc") {
        return (Number(b.latency) || -1) - (Number(a.latency) || -1);
      }
      if (sort === "latency-asc") {
        return (
          (Number(a.latency) || Number.POSITIVE_INFINITY) -
          (Number(b.latency) || Number.POSITIVE_INFINITY)
        );
      }
      if (sort === "status") {
        return `${a.category}:${a.status || 0}`.localeCompare(
          `${b.category}:${b.status || 0}`,
          "ru",
        );
      }
      if (sort === "domain") {
        return domainOf(a.normalizedUrl).localeCompare(
          domainOf(b.normalizedUrl),
          "ru",
        );
      }
      return (order.get(a.key) || 0) - (order.get(b.key) || 0);
    });
  }, [category, results, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filteredResults.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleResults = filteredResults.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );

  const setPreference = <K extends keyof Preferences>(
    key: K,
    value: Preferences[K],
  ) => {
    setPreferences((current) => ({ ...current, [key]: value }));
  };

  const appendInput = (text: string) => {
    setInput((current) =>
      current.trim()
        ? `${current.trim()}\n${String(text).trim()}`
        : String(text).trim(),
    );
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return showToast("Буфер обмена пуст.");
      appendInput(text);
      showToast("Ссылки вставлены.");
    } catch {
      showToast("Вставьте текст вручную — браузер не дал доступ к буферу.");
    }
  };

  const importFile = async (file?: File) => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      showToast("Файл больше 5 МБ.");
      return;
    }
    if (!/\.(txt|csv|xml)$/i.test(file.name)) {
      showToast("Поддерживаются TXT, CSV и sitemap.xml.");
      return;
    }
    try {
      const text = await file.text();
      const urls = parseInputCandidates(text);
      if (!urls.length) {
        showToast("В файле не найдено ссылок.");
        return;
      }
      appendInput(urls.join("\n"));
      showToast(`Импортировано: ${numberFormat.format(urls.length)} URL.`);
    } catch {
      showToast("Не удалось прочитать файл.");
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    void importFile(event.dataTransfer.files?.[0]);
  };

  const generateUrls = () => {
    if (
      !generatorPattern.includes("{num}") ||
      !generatorPattern.includes("{letters}")
    ) {
      showToast("Шаблон должен содержать {num} и {letters}.");
      return;
    }
    const start = Number(generatorStart);
    const end = Number(generatorEnd);
    const direction = start <= end ? 1 : -1;
    const codes = [
      ...new Set(
        generatorCodes
          .split(/[\s,;]+/)
          .map((code) => code.trim())
          .filter(Boolean),
      ),
    ];
    if (!Number.isFinite(start) || !Number.isFinite(end) || !codes.length) {
      showToast("Проверьте диапазон и буквенные коды.");
      return;
    }
    const generated: string[] = [];
    for (
      let number = start;
      direction > 0 ? number <= end : number >= end;
      number += direction
    ) {
      for (const code of codes) {
        generated.push(
          generatorPattern
            .replaceAll("{num}", String(number))
            .replaceAll("{letters}", code),
        );
        if (generated.length >= 500) break;
      }
      if (generated.length >= 500) break;
    }
    appendInput(generated.join("\n"));
    setGeneratorOpen(false);
    showToast(`Сгенерировано: ${numberFormat.format(generated.length)} URL.`);
  };

  const updateFromStream = useCallback(
    (event: StreamEvent) => {
      if (event.type === "error") {
        throw new Error(event.error || "Ошибка потоковой проверки.");
      }
      if (event.type !== "result" || !event.result || !event.entry) return;

      const incoming = event.result;
      const incomingKey = canonicalize(
        incoming.normalizedUrl ||
          event.entry.normalizedUrl ||
          event.entry.originalUrl,
      );
      const current = resultsRef.current;
      const index = current.findIndex(
        (item) =>
          item.key === incomingKey ||
          item.originalUrl === event.entry?.originalUrl,
      );
      if (index >= 0) {
        const next = [...current];
        next[index] = {
          ...next[index],
          ...incoming,
          key: incomingKey,
          occurrences:
            event.entry.occurrences || next[index].occurrences || 1,
        } as ResultItem;
        commitResults(next);
      }

      const elapsedSeconds = Math.max(
        0.001,
        (performance.now() - progressRef.current.startedAt) / 1_000,
      );
      const checked = progressRef.current.checked + 1;
      const remaining = Math.max(0, progressRef.current.total - checked);
      const speed = checked / elapsedSeconds;
      const nextProgress: ProgressState = {
        ...progressRef.current,
        checked,
        success:
          progressRef.current.success +
          (incoming.ok && incoming.category !== "redirect" ? 1 : 0),
        redirects:
          progressRef.current.redirects +
          (incoming.category === "redirect" ? 1 : 0),
        errors: progressRef.current.errors + (incoming.ok ? 0 : 1),
        cached:
          progressRef.current.cached + (incoming.cached ? 1 : 0),
        speed,
        etaSeconds: remaining > 0 ? remaining / Math.max(speed, 0.001) : 0,
      };
      commitProgress(nextProgress);
    },
    [commitProgress, commitResults],
  );

  const runApiBatch = useCallback(
    async (
      urls: string[],
      controller: AbortController,
      force: boolean,
    ) => {
      const response = await fetch("/api/check-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          urls,
          mode,
          concurrency,
          force,
        }),
      });
      if (!response.ok) {
        let payload: { error?: string } = {};
        try {
          payload = await response.json();
        } catch {
          // Preserve the HTTP fallback below.
        }
        throw new Error(
          payload.error || `Сервис проверки вернул HTTP ${response.status}.`,
        );
      }
      if (!response.body) {
        throw new Error("Браузер не поддерживает потоковые результаты.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) updateFromStream(JSON.parse(line) as StreamEvent);
        }
        if (done) break;
      }
      if (buffer.trim()) {
        updateFromStream(JSON.parse(buffer) as StreamEvent);
      }
    },
    [concurrency, mode, updateFromStream],
  );

  const storeHistory = useCallback(
    (durationMs: number) => {
      if (!saveHistory) return;
      const finalResults = resultsRef.current;
      const nextEntry: HistoryEntry = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        durationMs,
        mode,
        counts: {
          total: finalResults.length,
          working: finalResults.filter(
            (item) => item.ok && item.category !== "redirect",
          ).length,
          redirects: finalResults.filter(
            (item) => item.category === "redirect",
          ).length,
          errors: finalResults.filter((item) => !item.ok).length,
        },
        urls:
          finalResults.length <= 500
            ? finalResults.map((item) => item.originalUrl)
            : [],
      };
      setHistory((current) => {
        const fresh = [nextEntry, ...current]
          .filter(
            (entry) => Date.now() - entry.createdAt < 7 * 24 * 60 * 60 * 1_000,
          )
          .slice(0, 10);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(fresh));
        } catch {
          showToast("История не сохранилась: хранилище браузера заполнено.");
        }
        return fresh;
      });
    },
    [mode, saveHistory, showToast],
  );

  const runUrls = useCallback(
    async (
      entries: Array<{
        url: string;
        key: string;
        occurrences: number;
      }>,
      options: { fresh: boolean; force: boolean },
    ) => {
      if (running || !entries.length) return;
      setRunning(true);
      setValidationMessage("");
      const controller = new AbortController();
      controllerRef.current = controller;

      if (options.fresh) {
        commitResults(
          entries.map((entry) => ({
            key: entry.key,
            originalUrl: entry.url,
            normalizedUrl: entry.key,
            occurrences: entry.occurrences,
            ok: false,
            category: "pending",
            label: "В очереди",
            status: null,
            latency: null,
            diagnostic: "Ожидает проверки.",
          })),
        );
        setSelected(new Set());
        setPage(1);
      } else {
        const targetKeys = new Set(entries.map((entry) => entry.key));
        commitResults(
          resultsRef.current.map((item) =>
            targetKeys.has(item.key)
              ? {
                  ...item,
                  category: "checking",
                  label: "Проверяем",
                  diagnostic: "URL возвращён в очередь.",
                }
              : item,
          ),
        );
      }

      const startedAt = performance.now();
      commitProgress({
        ...emptyProgress,
        total: entries.length,
        startedAt,
        state: "running",
      });
      requestAnimationFrame(() =>
        progressRefEl.current?.scrollIntoView({
          behavior: preferences.motion ? "smooth" : "auto",
          block: "center",
        }),
      );

      try {
        for (let index = 0; index < entries.length; index += API_BATCH_SIZE) {
          if (controller.signal.aborted) break;
          await runApiBatch(
            entries
              .slice(index, index + API_BATCH_SIZE)
              .map((entry) => entry.url),
            controller,
            options.force,
          );
        }
        if (!controller.signal.aborted) {
          const duration = performance.now() - startedAt;
          commitProgress({ ...progressRef.current, state: "done" });
          storeHistory(duration);
          showToast(`Проверка завершена за ${formatDuration(duration)}.`);
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          commitResults(
            resultsRef.current.map((item) =>
              ["pending", "checking"].includes(item.category)
                ? {
                    ...item,
                    category: "cancelled",
                    label: "Остановлено",
                    diagnostic: "Проверка остановлена пользователем.",
                  }
                : item,
            ),
          );
          commitProgress({ ...progressRef.current, state: "stopped" });
          showToast("Проверка остановлена. Полученные результаты сохранены.");
        } else {
          const message =
            error instanceof Error
              ? error.message
              : "Не удалось завершить проверку.";
          commitResults(
            resultsRef.current.map((item) =>
              ["pending", "checking"].includes(item.category)
                ? {
                    ...item,
                    category: "network_error",
                    label: "Ошибка сервиса",
                    diagnostic: message,
                  }
                : item,
            ),
          );
          commitProgress({ ...progressRef.current, state: "error" });
          showToast(message);
        }
      } finally {
        controllerRef.current = null;
        setRunning(false);
      }
    },
    [
      commitProgress,
      commitResults,
      preferences.motion,
      runApiBatch,
      running,
      showToast,
      storeHistory,
    ],
  );

  const startInitialCheck = () => {
    if (!inputEntries.length) {
      setValidationMessage("Добавьте хотя бы один URL.");
      inputPanelRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (inputEntries.length > MAX_URLS) {
      setValidationMessage(
        `За один запуск можно проверить не более ${numberFormat.format(MAX_URLS)} URL.`,
      );
      return;
    }
    void runUrls(inputEntries, {
      fresh: true,
      force: !useCache,
    });
  };

  const stopCheck = () => controllerRef.current?.abort();

  const recheckItems = (items: ResultItem[]) => {
    if (!items.length || running) return;
    void runUrls(
      items.map((item) => ({
        url: item.originalUrl,
        key: item.key,
        occurrences: item.occurrences,
      })),
      { fresh: false, force: true },
    );
  };

  const toggleSelection = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    const allVisibleSelected =
      visibleResults.length > 0 &&
      visibleResults.every((item) => selected.has(item.key));
    setSelected((current) => {
      const next = new Set(current);
      for (const item of visibleResults) {
        if (allVisibleSelected) next.delete(item.key);
        else next.add(item.key);
      }
      return next;
    });
  };

  const deleteSelected = () => {
    if (!selected.size || running) return;
    commitResults(resultsRef.current.filter((item) => !selected.has(item.key)));
    showToast(`Удалено: ${numberFormat.format(selected.size)}.`);
    setSelected(new Set());
  };

  const copySelected = async () => {
    const urls = results
      .filter((item) => selected.has(item.key))
      .map((item) => item.originalUrl);
    if (!urls.length) return;
    try {
      await navigator.clipboard.writeText(urls.join("\n"));
      showToast(`Скопировано: ${numberFormat.format(urls.length)} URL.`);
    } catch {
      showToast("Браузер не разрешил копирование.");
    }
  };

  const moveSelectedToInput = () => {
    const urls = results
      .filter((item) => selected.has(item.key))
      .map((item) => item.originalUrl);
    if (!urls.length) return;
    setInput(urls.join("\n"));
    inputPanelRef.current?.scrollIntoView({
      behavior: preferences.motion ? "smooth" : "auto",
      block: "center",
    });
    showToast(`Подготовлен новый запуск: ${urls.length} URL.`);
  };

  const download = (filename: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const exportResults = (format: "csv" | "json" | "txt") => {
    let rows = filteredResults;
    if (exportScope === "all") rows = results;
    if (exportScope === "selected") {
      rows = results.filter((item) => selected.has(item.key));
    }
    if (exportScope === "errors") {
      rows = results.filter(resultIsProblem);
    }
    if (!rows.length) {
      showToast("В выбранном наборе нет результатов.");
      return;
    }

    if (format === "json") {
      download(
        "linkpulse-report.json",
        JSON.stringify(rows, null, 2),
        "application/json;charset=utf-8",
      );
    } else if (format === "txt") {
      download(
        "linkpulse-urls.txt",
        rows.map((item) => item.originalUrl).join("\n"),
        "text/plain;charset=utf-8",
      );
    } else {
      const headers = [
        "url",
        "category",
        "label",
        "http_status",
        "final_url",
        "latency_ms",
        "redirects",
        "content_type",
        "content_length",
        "checked_at",
        "cached",
        "diagnostic",
      ];
      const data = rows.map((item) => [
        item.originalUrl,
        item.category,
        item.label,
        item.status,
        item.finalUrl,
        item.latency,
        item.redirectCount,
        item.contentType,
        item.contentLength,
        item.checkedAt,
        item.cached,
        item.diagnostic,
      ]);
      download(
        "linkpulse-report.csv",
        `\ufeff${[headers, ...data]
          .map((row) => row.map(csvEscape).join(","))
          .join("\n")}`,
        "text/csv;charset=utf-8",
      );
    }
    setExportOpen(false);
    showToast(`Экспортировано: ${numberFormat.format(rows.length)} строк.`);
  };

  const clearHistory = () => {
    localStorage.removeItem(HISTORY_KEY);
    setHistory([]);
    showToast("Локальная история очищена.");
  };

  const runHistoryEntry = (entry: HistoryEntry) => {
    if (!entry.urls.length) {
      showToast("Для большого запуска сохранена только сводка.");
      return;
    }
    setInput(entry.urls.join("\n"));
    setMode(entry.mode);
    inputPanelRef.current?.scrollIntoView({
      behavior: preferences.motion ? "smooth" : "auto",
      block: "center",
    });
  };

  const selectedItems = results.filter((item) => selected.has(item.key));
  const percent = progress.total
    ? Math.min(100, Math.round((progress.checked / progress.total) * 100))
    : 0;
  const resultRangeStart = visibleResults.length
    ? (safePage - 1) * pageSize + 1
    : 0;
  const resultRangeEnd = Math.min(
    safePage * pageSize,
    filteredResults.length,
  );
  const selectedVisible =
    visibleResults.length > 0 &&
    visibleResults.every((item) => selected.has(item.key));

  const appStyle = {
    "--glass-strength": `${preferences.glass}%`,
  } as CSSProperties;

  return (
    <main
      className="app"
      data-theme={preferences.theme}
      data-wallpaper={preferences.wallpaper}
      data-accent={preferences.accent}
      data-density={preferences.density}
      data-motion={preferences.motion ? "on" : "off"}
      style={appStyle}
    >
      <div className="wallpaper" aria-hidden="true" />
      <div className="noise" aria-hidden="true" />

      <header className="topbar">
        <a className="brand" href="#top" aria-label="LinkPulse, начало страницы">
          <span className="brand-mark">
            <Activity size={19} strokeWidth={2.4} />
          </span>
          <span>
            <strong>LINKPULSE</strong>
            <small>URL intelligence</small>
          </span>
        </a>
        <div className="topbar-center" aria-label="Статус сервиса">
          <span className="live-dot" />
          Сервис готов
        </div>
        <nav className="topbar-actions" aria-label="Быстрые действия">
          <button
            className="icon-button mobile-hidden"
            type="button"
            onClick={() => setHelpOpen(true)}
          >
            <Info size={18} />
            <span>Как работает</span>
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => setPreference(
              "theme",
              preferences.theme === "dark" ? "light" : "dark",
            )}
            aria-label={
              preferences.theme === "dark"
                ? "Включить светлую тему"
                : "Включить тёмную тему"
            }
          >
            {preferences.theme === "dark" ? (
              <Sun size={18} />
            ) : (
              <Moon size={18} />
            )}
          </button>
          <button
            className="settings-button"
            type="button"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={18} />
            <span>Настроить</span>
          </button>
        </nav>
      </header>

      <div className="content" id="top">
        <section className="hero" aria-labelledby="page-title">
          <div className="hero-copy">
            <span className="eyebrow">
              <Sparkles size={14} />
              Link intelligence workspace
            </span>
            <h1 id="page-title">
              Проверьте все ссылки.
              <span> Увидьте слабые места.</span>
            </h1>
            <p>
              Потоковая диагностика доступности, редиректов и скорости —
              без ожидания полного отчёта и лишнего шума.
            </p>
          </div>
          <div className="hero-proof">
            <div>
              <strong>1 000</strong>
              <span>URL за запуск</span>
            </div>
            <div>
              <strong>Live</strong>
              <span>результаты сразу</span>
            </div>
            <div>
              <strong>Safe</strong>
              <span>защита целей</span>
            </div>
          </div>
        </section>

        <section className="workspace" aria-label="Рабочая область проверки">
          <section
            className={`panel input-panel ${dragging ? "is-dragging" : ""}`}
            ref={inputPanelRef}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDragging(false);
              }
            }}
            onDrop={onDrop}
          >
            <div className="panel-header">
              <div>
                <span className="step-label">01 · Источник</span>
                <h2>Ссылки для проверки</h2>
              </div>
              <span className="limit-chip">
                до {numberFormat.format(MAX_URLS)}
              </span>
            </div>

            <div className="editor-shell">
              <div className="editor-topline">
                <span className="window-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>URL LIST</span>
                <span className="editor-counter">
                  {numberFormat.format(inputStats.unique)} уникальных
                </span>
              </div>
              <textarea
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setValidationMessage("");
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                placeholder={
                  "https://example.com/\nexample.org/pricing\nhttps://example.net/missing-page"
                }
                aria-label="Ссылки, по одной на строку"
              />
              {dragging && (
                <div className="drop-overlay">
                  <UploadCloud size={30} />
                  <strong>Отпустите файл</strong>
                  <span>TXT, CSV или sitemap.xml</span>
                </div>
              )}
              <div className="editor-footer">
                <span>
                  {inputStats.duplicates > 0 &&
                    `${inputStats.duplicates} дубликатов скрыто`}
                  {inputStats.duplicates > 0 &&
                    inputStats.invalid > 0 &&
                    " · "}
                  {inputStats.invalid > 0 &&
                    `${inputStats.invalid} требуют проверки формата`}
                  {!inputStats.duplicates &&
                    !inputStats.invalid &&
                    "http:// и https:// · домены без протокола дополняются автоматически"}
                </span>
                <Keyboard size={15} aria-hidden="true" />
                <kbd>⌘</kbd>
                <kbd>↵</kbd>
              </div>
            </div>

            <div className="input-actions">
              <button
                className="soft-button"
                type="button"
                onClick={() => void pasteFromClipboard()}
              >
                <Clipboard size={17} />
                Вставить
              </button>
              <button
                className="soft-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp size={17} />
                Импорт
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.xml,text/plain,text/csv,application/xml,text/xml"
                hidden
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  void importFile(event.target.files?.[0])
                }
              />
              <button
                className="soft-button"
                type="button"
                onClick={() => setGeneratorOpen((current) => !current)}
                aria-expanded={generatorOpen}
              >
                <WandSparkles size={17} />
                Генератор
                <ChevronDown
                  className={generatorOpen ? "rotate" : ""}
                  size={15}
                />
              </button>
              <button
                className="soft-button"
                type="button"
                onClick={() => {
                  setInput(sampleUrls);
                  setValidationMessage("");
                }}
              >
                <Sparkles size={17} />
                Демо
              </button>
              {input && (
                <button
                  className="text-button destructive-text"
                  type="button"
                  onClick={() => {
                    setInput("");
                    setValidationMessage("");
                  }}
                >
                  Очистить
                </button>
              )}
            </div>

            {generatorOpen && (
              <div className="generator-panel">
                <div className="generator-heading">
                  <div>
                    <span className="mini-label">Pattern lab</span>
                    <strong>Создать серию URL</strong>
                  </div>
                  <button
                    className="round-button"
                    type="button"
                    onClick={() => setGeneratorOpen(false)}
                    aria-label="Закрыть генератор"
                  >
                    <X size={16} />
                  </button>
                </div>
                <label className="field field-wide">
                  <span>Шаблон</span>
                  <input
                    value={generatorPattern}
                    onChange={(event) =>
                      setGeneratorPattern(event.target.value)
                    }
                  />
                </label>
                <div className="generator-grid">
                  <label className="field">
                    <span>От</span>
                    <input
                      type="number"
                      value={generatorStart}
                      onChange={(event) =>
                        setGeneratorStart(Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>До</span>
                    <input
                      type="number"
                      value={generatorEnd}
                      onChange={(event) =>
                        setGeneratorEnd(Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="field codes-field">
                    <span>Коды</span>
                    <input
                      value={generatorCodes}
                      onChange={(event) =>
                        setGeneratorCodes(event.target.value)
                      }
                    />
                  </label>
                  <button
                    className="primary-button generator-button"
                    type="button"
                    onClick={generateUrls}
                  >
                    Добавить
                    <ArrowRight size={17} />
                  </button>
                </div>
              </div>
            )}

            <div className="options-grid">
              <fieldset className="option-card">
                <legend>Глубина проверки</legend>
                <div className="segmented">
                  <button
                    type="button"
                    className={mode === "quick" ? "active" : ""}
                    onClick={() => setMode("quick")}
                  >
                    <Zap size={16} />
                    <span>
                      <b>Быстрая</b>
                      <small>Статус и время</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={mode === "full" ? "active" : ""}
                    onClick={() => setMode("full")}
                  >
                    <Gauge size={16} />
                    <span>
                      <b>Полная</b>
                      <small>Заголовки и размер</small>
                    </span>
                  </button>
                </div>
              </fieldset>

              <fieldset className="option-card">
                <legend>Параллельность</legend>
                <div className="speed-selector">
                  {[3, 6, 9, 12].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={concurrency === value ? "active" : ""}
                      onClick={() => setConcurrency(value)}
                      aria-label={`${value} одновременных проверок`}
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <span className="option-caption">
                  {concurrency <= 3
                    ? "Бережно"
                    : concurrency <= 6
                      ? "Оптимально"
                      : concurrency <= 9
                        ? "Быстро"
                        : "Максимум"}
                </span>
              </fieldset>
            </div>

            <div className="toggle-row">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={useCache}
                  onChange={(event) => setUseCache(event.target.checked)}
                />
                <span className="switch" />
                <span>
                  <b>Свежий кэш</b>
                  <small>Меньше повторных запросов</small>
                </span>
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={saveHistory}
                  onChange={(event) => setSaveHistory(event.target.checked)}
                />
                <span className="switch" />
                <span>
                  <b>История</b>
                  <small>Только на этом устройстве</small>
                </span>
              </label>
            </div>

            {validationMessage && (
              <p className="validation-message" role="alert">
                <AlertCircle size={17} />
                {validationMessage}
              </p>
            )}

            <button
              className="primary-button run-button"
              type="button"
              onClick={startInitialCheck}
              disabled={running}
              data-primary-run
            >
              {running ? (
                <LoaderCircle className="spin" size={20} />
              ) : (
                <Play size={20} fill="currentColor" />
              )}
              <span>
                {running ? "Проверка идёт" : "Запустить проверку"}
                <small>
                  {inputEntries.length
                    ? `${numberFormat.format(inputEntries.length)} URL · ${mode === "full" ? "полный режим" : "быстрый режим"}`
                    : "Добавьте ссылки или откройте демо"}
                </small>
              </span>
              <ArrowRight className="run-arrow" size={21} />
            </button>
          </section>

          <aside
            className="panel monitor-panel"
            ref={progressRefEl}
            aria-live="polite"
          >
            <div className="panel-header">
              <div>
                <span className="step-label">
                  02 · {progress.state === "idle" ? "Готовность" : "Мониторинг"}
                </span>
                <h2>
                  {progress.state === "running"
                    ? "Проверяем сейчас"
                    : progress.state === "done"
                      ? "Проверка завершена"
                      : progress.state === "stopped"
                        ? "Проверка остановлена"
                        : progress.state === "error"
                          ? "Возникла ошибка"
                          : "Сводка запуска"}
                </h2>
              </div>
              {running && (
                <button
                  className="stop-button"
                  type="button"
                  onClick={stopCheck}
                >
                  <CircleStop size={17} />
                  Стоп
                </button>
              )}
            </div>

            {progress.state === "idle" && !results.length ? (
              <div className="ready-state">
                <div className="ready-orbit" aria-hidden="true">
                  <span />
                  <Activity size={38} />
                </div>
                <h3>Результаты появятся в реальном времени</h3>
                <p>
                  Сначала статус, затем скорость, редиректы и диагностические
                  детали — по мере готовности каждого URL.
                </p>
                <div className="capability-list">
                  <span>
                    <ShieldCheck size={17} />
                    Безопасная проверка целей
                  </span>
                  <span>
                    <RefreshCw size={17} />
                    Повтор проблем в один клик
                  </span>
                  <span>
                    <Download size={17} />
                    CSV, JSON и TXT
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className="progress-visual">
                  <div
                    className="progress-ring"
                    style={{ "--progress": `${percent * 3.6}deg` } as CSSProperties}
                    aria-label={`Прогресс ${percent}%`}
                  >
                    <div>
                      <strong>{percent}%</strong>
                      <span>
                        {numberFormat.format(progress.checked)} /{" "}
                        {numberFormat.format(progress.total)}
                      </span>
                    </div>
                  </div>
                  <div className="progress-copy">
                    <span className={`run-state state-${progress.state}`}>
                      {progress.state === "running" && (
                        <LoaderCircle className="spin" size={14} />
                      )}
                      {progress.state === "done" && <Check size={14} />}
                      {progress.state === "stopped" && (
                        <CircleStop size={14} />
                      )}
                      {progress.state === "error" && (
                        <AlertCircle size={14} />
                      )}
                      {progress.state === "running"
                        ? "Поток активен"
                        : progress.state === "done"
                          ? "Готово"
                          : progress.state === "stopped"
                            ? "Остановлено"
                            : progress.state === "error"
                              ? "Ошибка"
                              : "Последний запуск"}
                    </span>
                    <h3>
                      {progress.state === "running"
                        ? `${progress.speed.toFixed(1)} URL/с`
                        : `${numberFormat.format(summary.total)} результатов`}
                    </h3>
                    <p>
                      {progress.state === "running"
                        ? `Осталось примерно ${progress.etaSeconds === null ? "—" : formatDuration(progress.etaSeconds * 1_000)}`
                        : progress.cached
                          ? `${progress.cached} ответов получено из свежего кэша`
                          : "Отчёт готов к фильтрации и экспорту"}
                    </p>
                  </div>
                </div>

                <div className="metric-grid">
                  <div className="metric metric-success">
                    <span>
                      <CheckCircle2 size={17} />
                      Работают
                    </span>
                    <strong>{numberFormat.format(progress.success)}</strong>
                  </div>
                  <div className="metric metric-warning">
                    <span>
                      <RefreshCw size={17} />
                      Редиректы
                    </span>
                    <strong>{numberFormat.format(progress.redirects)}</strong>
                  </div>
                  <div className="metric metric-danger">
                    <span>
                      <AlertCircle size={17} />
                      Ошибки
                    </span>
                    <strong>{numberFormat.format(progress.errors)}</strong>
                  </div>
                  <div className="metric metric-neutral">
                    <span>
                      <Gauge size={17} />
                      В кэше
                    </span>
                    <strong>{numberFormat.format(progress.cached)}</strong>
                  </div>
                </div>
              </>
            )}

            <div className="privacy-note">
              <ShieldCheck size={16} />
              <span>
                История отключена по умолчанию. Настройки остаются в вашем
                браузере.
              </span>
            </div>
          </aside>
        </section>

        <section
          className="panel results-panel"
          aria-labelledby="results-title"
          aria-busy={running}
        >
          <div className="results-top">
            <div>
              <span className="step-label">03 · Отчёт</span>
              <h2 id="results-title">Результаты</h2>
              <p>
                {results.length
                  ? `${numberFormat.format(filteredResults.length)} из ${numberFormat.format(results.length)} URL`
                  : "Запустите проверку — отчёт соберётся здесь."}
              </p>
            </div>
            {results.length > 0 && (
              <div className="summary-cluster" aria-label="Сводка результатов">
                <span className="summary-stat success">
                  <i />
                  {summary.working}
                  <small>работают</small>
                </span>
                <span className="summary-stat warning">
                  <i />
                  {summary.redirects}
                  <small>редиректы</small>
                </span>
                <span className="summary-stat danger">
                  <i />
                  {summary.errors}
                  <small>ошибки</small>
                </span>
              </div>
            )}
          </div>

          {results.length > 0 && (
            <>
              <div className="results-toolbar">
                <label className="search-box">
                  <Search size={18} />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(1);
                    }}
                    placeholder="Найти URL, домен или статус"
                    aria-label="Поиск по результатам"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setPage(1);
                      }}
                      aria-label="Очистить поиск"
                    >
                      <X size={15} />
                    </button>
                  )}
                </label>
                <label className="select-box">
                  <ListFilter size={17} />
                  <select
                    value={sort}
                    onChange={(event) => {
                      setSort(event.target.value);
                      setPage(1);
                    }}
                    aria-label="Сортировка"
                  >
                    <option value="original">Исходный порядок</option>
                    <option value="status">По статусу</option>
                    <option value="latency-desc">Сначала медленные</option>
                    <option value="latency-asc">Сначала быстрые</option>
                    <option value="domain">По домену</option>
                  </select>
                  <ChevronDown size={15} />
                </label>
                <button
                  className="export-main-button"
                  type="button"
                  onClick={() => setExportOpen(true)}
                >
                  <Download size={17} />
                  Экспорт
                </button>
              </div>

              <div className="filter-strip" role="tablist" aria-label="Фильтры">
                {filterOptions.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    className={category === filter.id ? "active" : ""}
                    onClick={() => {
                      setCategory(filter.id);
                      setPage(1);
                    }}
                    role="tab"
                    aria-selected={category === filter.id}
                  >
                    {filter.label}
                    {filter.id === "problems" && summary.errors + summary.slow > 0 && (
                      <span>{summary.errors + summary.slow}</span>
                    )}
                  </button>
                ))}
              </div>

              {selected.size > 0 && (
                <div className="bulk-bar">
                  <strong>{numberFormat.format(selected.size)} выбрано</strong>
                  <div>
                    <button
                      type="button"
                      onClick={() => recheckItems(selectedItems)}
                      disabled={running}
                    >
                      <RefreshCw size={16} />
                      Перепроверить
                    </button>
                    <button type="button" onClick={() => void copySelected()}>
                      <Copy size={16} />
                      Копировать
                    </button>
                    <button type="button" onClick={moveSelectedToInput}>
                      <ArrowRight size={16} />
                      В новый запуск
                    </button>
                    <button
                      type="button"
                      className="danger-action"
                      onClick={deleteSelected}
                      disabled={running}
                    >
                      <Trash2 size={16} />
                      Удалить
                    </button>
                  </div>
                  <button
                    className="bulk-close"
                    type="button"
                    onClick={() => setSelected(new Set())}
                    aria-label="Снять выбор"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
            </>
          )}

          {!results.length ? (
            <div className="empty-results">
              <div className="empty-visual" aria-hidden="true">
                <Link2 size={30} />
                <span />
                <span />
                <span />
              </div>
              <h3>Чистый отчёт начинается с первого URL</h3>
              <p>
                Добавьте список вручную, импортируйте sitemap или откройте
                демонстрационный набор.
              </p>
              <button
                className="soft-button"
                type="button"
                onClick={() =>
                  inputPanelRef.current?.scrollIntoView({
                    behavior: preferences.motion ? "smooth" : "auto",
                  })
                }
              >
                Перейти к вводу
                <ArrowRight size={16} />
              </button>
            </div>
          ) : filteredResults.length === 0 ? (
            <div className="empty-results compact-empty">
              <Search size={28} />
              <h3>Ничего не найдено</h3>
              <p>Измените запрос или сбросьте фильтры.</p>
              <button
                className="soft-button"
                type="button"
                onClick={() => {
                  setSearch("");
                  setCategory("all");
                  setPage(1);
                }}
              >
                Сбросить фильтры
              </button>
            </div>
          ) : (
            <>
              <div className="desktop-table-wrap">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th className="select-column">
                        <input
                          type="checkbox"
                          checked={selectedVisible}
                          onChange={toggleVisibleSelection}
                          aria-label="Выбрать видимые результаты"
                        />
                      </th>
                      <th>URL</th>
                      <th>Статус</th>
                      <th>HTTP</th>
                      <th>Скорость</th>
                      <th>Проверено</th>
                      <th>
                        <span className="sr-only">Действия</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleResults.map((item) => {
                      const href = safeHref(
                        item.finalUrl ||
                          item.normalizedUrl ||
                          item.originalUrl,
                      );
                      return (
                        <tr key={item.key}>
                          <td className="select-column">
                            <input
                              type="checkbox"
                              checked={selected.has(item.key)}
                              onChange={() => toggleSelection(item.key)}
                              aria-label={`Выбрать ${item.originalUrl}`}
                            />
                          </td>
                          <td>
                            <div className="url-stack">
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {item.originalUrl}
                                  <ExternalLink size={13} />
                                </a>
                              ) : (
                                <span>{item.originalUrl}</span>
                              )}
                              <small>
                                {domainOf(
                                  item.normalizedUrl || item.originalUrl,
                                )}
                                {item.occurrences > 1 &&
                                  ` · ×${item.occurrences}`}
                                {item.cached && " · кэш"}
                              </small>
                            </div>
                          </td>
                          <td>
                            <span
                              className={`status-badge tone-${statusTone(item.category)}`}
                            >
                              {item.category === "checking" && (
                                <LoaderCircle className="spin" size={13} />
                              )}
                              {item.label}
                            </span>
                          </td>
                          <td>
                            <span className="mono-value">
                              {item.status || "—"}
                            </span>
                          </td>
                          <td>
                            <span className="latency-value">
                              {formatDuration(item.latency)}
                            </span>
                          </td>
                          <td>
                            <span className="checked-time">
                              {item.checkedAt
                                ? new Date(item.checkedAt).toLocaleTimeString(
                                    "ru-RU",
                                    {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                      second: "2-digit",
                                    },
                                  )
                                : "—"}
                            </span>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                type="button"
                                onClick={() => setDetails(item)}
                                aria-label={`Детали ${item.originalUrl}`}
                              >
                                <Info size={16} />
                              </button>
                              <button
                                type="button"
                                onClick={() => recheckItems([item])}
                                disabled={running}
                                aria-label={`Перепроверить ${item.originalUrl}`}
                              >
                                <RefreshCw size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mobile-result-list">
                <button
                  className="select-visible-mobile"
                  type="button"
                  onClick={toggleVisibleSelection}
                >
                  <span
                    className={`fake-check ${selectedVisible ? "checked" : ""}`}
                  >
                    {selectedVisible && <Check size={12} />}
                  </span>
                  {selectedVisible
                    ? "Снять выбор на странице"
                    : "Выбрать на странице"}
                </button>
                {visibleResults.map((item) => {
                  const href = safeHref(
                    item.finalUrl || item.normalizedUrl || item.originalUrl,
                  );
                  return (
                    <article className="result-card" key={item.key}>
                      <div className="result-card-top">
                        <button
                          className={`fake-check ${selected.has(item.key) ? "checked" : ""}`}
                          type="button"
                          onClick={() => toggleSelection(item.key)}
                          aria-label={`Выбрать ${item.originalUrl}`}
                        >
                          {selected.has(item.key) && <Check size={12} />}
                        </button>
                        <div className="result-card-url">
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {item.originalUrl}
                            </a>
                          ) : (
                            <span>{item.originalUrl}</span>
                          )}
                          <small>
                            {domainOf(item.normalizedUrl || item.originalUrl)}
                          </small>
                        </div>
                        <span
                          className={`status-badge tone-${statusTone(item.category)}`}
                        >
                          {item.label}
                        </span>
                      </div>
                      <div className="result-card-metrics">
                        <div>
                          <small>HTTP</small>
                          <strong>{item.status || "—"}</strong>
                        </div>
                        <div>
                          <small>Время</small>
                          <strong>{formatDuration(item.latency)}</strong>
                        </div>
                        <div>
                          <small>Редиректы</small>
                          <strong>{item.redirectCount ?? "—"}</strong>
                        </div>
                      </div>
                      <div className="result-card-actions">
                        <button type="button" onClick={() => setDetails(item)}>
                          <Info size={16} />
                          Детали
                        </button>
                        <button
                          type="button"
                          onClick={() => recheckItems([item])}
                          disabled={running}
                        >
                          <RefreshCw size={16} />
                          Ещё раз
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="pagination">
                <span>
                  {numberFormat.format(resultRangeStart)}–
                  {numberFormat.format(resultRangeEnd)} из{" "}
                  {numberFormat.format(filteredResults.length)}
                </span>
                <label>
                  На странице
                  <select
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value));
                      setPage(1);
                    }}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
                <div>
                  <button
                    type="button"
                    onClick={() => setPage(Math.max(1, safePage - 1))}
                    disabled={safePage <= 1}
                    aria-label="Предыдущая страница"
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <span>
                    {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPage(Math.min(totalPages, safePage + 1))
                    }
                    disabled={safePage >= totalPages}
                    aria-label="Следующая страница"
                  >
                    <ChevronRight size={17} />
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        {history.length > 0 && (
          <section className="panel history-panel" aria-labelledby="history-title">
            <div className="results-top">
              <div>
                <span className="step-label">04 · Локально</span>
                <h2 id="history-title">Недавние запуски</h2>
                <p>Хранятся на этом устройстве не более семи дней.</p>
              </div>
              <button
                className="text-button destructive-text"
                type="button"
                onClick={clearHistory}
              >
                Очистить
              </button>
            </div>
            <div className="history-grid">
              {history.slice(0, 6).map((entry) => (
                <article className="history-item" key={entry.id}>
                  <div className="history-icon">
                    <History size={18} />
                  </div>
                  <div>
                    <strong>
                      {new Date(entry.createdAt).toLocaleString("ru-RU", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </strong>
                    <p>
                      {entry.counts.total} URL · {entry.counts.errors} ошибок ·{" "}
                      {formatDuration(entry.durationMs)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => runHistoryEntry(entry)}
                    disabled={!entry.urls.length}
                  >
                    <Play size={15} />
                    {entry.urls.length ? "Повторить" : "Только сводка"}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        <footer className="footer">
          <div className="brand footer-brand">
            <span className="brand-mark">
              <Activity size={18} />
            </span>
            <span>
              <strong>LINKPULSE</strong>
              <small>Проверяйте спокойно</small>
            </span>
          </div>
          <p>Без аккаунта · без облачной истории · с понятной диагностикой</p>
          <button type="button" onClick={() => setHelpOpen(true)}>
            О принципах проверки
            <ArrowRight size={15} />
          </button>
        </footer>
      </div>

      <div className="mobile-run-dock">
        {running ? (
          <button type="button" className="mobile-stop" onClick={stopCheck}>
            <CircleStop size={19} />
            Остановить · {percent}%
          </button>
        ) : (
          <button
            type="button"
            onClick={startInitialCheck}
            disabled={!inputEntries.length}
          >
            <Play size={18} fill="currentColor" />
            Проверить {inputEntries.length || ""} URL
          </button>
        )}
      </div>

      {settingsOpen && (
        <div
          className="drawer-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setSettingsOpen(false);
          }}
        >
          <aside
            className="settings-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="drawer-header">
              <div>
                <span className="mini-label">Personal studio</span>
                <h2 id="settings-title">Внешний вид</h2>
              </div>
              <button
                className="round-button"
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Закрыть настройки"
              >
                <X size={18} />
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-label">
                <span>
                  <Sun size={16} />
                  Режим
                </span>
              </div>
              <div className="theme-switcher">
                <button
                  type="button"
                  className={preferences.theme === "dark" ? "active" : ""}
                  onClick={() => setPreference("theme", "dark")}
                >
                  <Moon size={16} />
                  Тёмный
                </button>
                <button
                  type="button"
                  className={preferences.theme === "light" ? "active" : ""}
                  onClick={() => setPreference("theme", "light")}
                >
                  <Sun size={16} />
                  Светлый
                </button>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">
                <span>
                  <Palette size={16} />
                  Обои
                </span>
                <small>Оригинальная коллекция</small>
              </div>
              <div className="wallpaper-grid">
                {wallpaperOptions.map((wallpaper) => (
                  <button
                    key={wallpaper.id}
                    className={`wallpaper-option wallpaper-${wallpaper.id} ${
                      preferences.wallpaper === wallpaper.id ? "active" : ""
                    }`}
                    type="button"
                    onClick={() => setPreference("wallpaper", wallpaper.id)}
                  >
                    <span className="wallpaper-preview">
                      {preferences.wallpaper === wallpaper.id && (
                        <i>
                          <Check size={14} />
                        </i>
                      )}
                    </span>
                    <span>
                      <b>{wallpaper.title}</b>
                      <small>{wallpaper.subtitle}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">
                <span>
                  <Sparkles size={16} />
                  Акцент
                </span>
              </div>
              <div className="accent-row">
                {accentOptions.map((accent) => (
                  <button
                    key={accent.id}
                    type="button"
                    className={
                      preferences.accent === accent.id ? "active" : ""
                    }
                    onClick={() => setPreference("accent", accent.id)}
                    aria-label={accent.title}
                    title={accent.title}
                  >
                    <span style={{ backgroundColor: accent.color }} />
                    {preferences.accent === accent.id && (
                      <Check size={14} />
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">
                <span>
                  <Activity size={16} />
                  Прозрачность стекла
                </span>
                <small>{preferences.glass}%</small>
              </div>
              <input
                className="range-input"
                type="range"
                min="36"
                max="92"
                value={preferences.glass}
                onChange={(event) =>
                  setPreference("glass", Number(event.target.value))
                }
              />
            </div>

            <div className="settings-section split-setting">
              <div>
                <strong>Плотный отчёт</strong>
                <small>Больше строк на экране</small>
              </div>
              <label className="switch-only">
                <input
                  type="checkbox"
                  checked={preferences.density === "compact"}
                  onChange={(event) =>
                    setPreference(
                      "density",
                      event.target.checked ? "compact" : "comfortable",
                    )
                  }
                />
                <span className="switch" />
              </label>
            </div>

            <div className="settings-section split-setting">
              <div>
                <strong>Мягкая анимация</strong>
                <small>Переходы и живой фон</small>
              </div>
              <label className="switch-only">
                <input
                  type="checkbox"
                  checked={preferences.motion}
                  onChange={(event) =>
                    setPreference("motion", event.target.checked)
                  }
                />
                <span className="switch" />
              </label>
            </div>

            <button
              className="reset-appearance"
              type="button"
              onClick={() => setPreferences(defaultPreferences)}
            >
              <RefreshCw size={16} />
              Вернуть исходный стиль
            </button>
          </aside>
        </div>
      )}

      {details && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setDetails(null);
          }}
        >
          <section
            className="modal details-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="details-title"
          >
            <div className="modal-header">
              <div>
                <span className="mini-label">URL diagnostics</span>
                <h2 id="details-title">{details.label}</h2>
              </div>
              <button
                className="round-button"
                type="button"
                onClick={() => setDetails(null)}
                aria-label="Закрыть детали"
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-status">
              <span
                className={`status-badge tone-${statusTone(details.category)}`}
              >
                {details.label}
              </span>
              <span>{details.diagnostic}</span>
            </div>
            <dl className="detail-grid">
              <div>
                <dt>Исходный URL</dt>
                <dd>{details.originalUrl}</dd>
              </div>
              <div>
                <dt>Конечный URL</dt>
                <dd>{details.finalUrl || "—"}</dd>
              </div>
              <div>
                <dt>HTTP</dt>
                <dd>
                  {details.status
                    ? `${details.status} ${details.statusText || ""}`.trim()
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Время ответа</dt>
                <dd>{formatDuration(details.latency)}</dd>
              </div>
              <div>
                <dt>Метод</dt>
                <dd>{details.method || "—"}</dd>
              </div>
              <div>
                <dt>Редиректы</dt>
                <dd>{details.redirectCount ?? "—"}</dd>
              </div>
              <div>
                <dt>Тип контента</dt>
                <dd>{details.contentType || "—"}</dd>
              </div>
              <div>
                <dt>Размер</dt>
                <dd>{formatBytes(details.contentLength)}</dd>
              </div>
              <div>
                <dt>Источник</dt>
                <dd>{details.cached ? "Свежий кэш" : "Новая проверка"}</dd>
              </div>
              <div>
                <dt>Проверено</dt>
                <dd>
                  {details.checkedAt
                    ? new Date(details.checkedAt).toLocaleString("ru-RU")
                    : "—"}
                </dd>
              </div>
            </dl>
            {details.redirectChain && details.redirectChain.length > 0 && (
              <div className="redirect-chain">
                <h3>Цепочка редиректов</h3>
                {details.redirectChain.map((hop, index) => (
                  <div key={`${hop.url}-${index}`}>
                    <span>{hop.status}</span>
                    <p>
                      <b>{hop.url}</b>
                      <small>{hop.location}</small>
                    </p>
                  </div>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="soft-button"
                type="button"
                onClick={() => {
                  setDetails(null);
                  recheckItems([details]);
                }}
                disabled={running}
              >
                <RefreshCw size={16} />
                Перепроверить
              </button>
              {safeHref(details.finalUrl || details.normalizedUrl) && (
                <a
                  className="primary-button"
                  href={safeHref(details.finalUrl || details.normalizedUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть URL
                  <ExternalLink size={16} />
                </a>
              )}
            </div>
          </section>
        </div>
      )}

      {exportOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setExportOpen(false);
          }}
        >
          <section
            className="modal export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-title"
          >
            <div className="modal-header">
              <div>
                <span className="mini-label">Report builder</span>
                <h2 id="export-title">Экспорт отчёта</h2>
              </div>
              <button
                className="round-button"
                type="button"
                onClick={() => setExportOpen(false)}
                aria-label="Закрыть экспорт"
              >
                <X size={18} />
              </button>
            </div>
            <div className="export-scopes">
              {[
                ["filtered", "Отфильтрованные", filteredResults.length],
                ["all", "Все результаты", results.length],
                ["selected", "Выбранные", selected.size],
                [
                  "errors",
                  "Проблемные",
                  results.filter(resultIsProblem).length,
                ],
              ].map(([scope, label, count]) => (
                <label key={String(scope)}>
                  <input
                    type="radio"
                    name="export-scope"
                    checked={exportScope === scope}
                    onChange={() => setExportScope(scope as ExportScope)}
                  />
                  <span>
                    <b>{label}</b>
                    <small>{numberFormat.format(Number(count))} строк</small>
                  </span>
                  <i>{exportScope === scope && <Check size={13} />}</i>
                </label>
              ))}
            </div>
            <div className="format-grid">
              <button type="button" onClick={() => exportResults("csv")}>
                <strong>CSV</strong>
                <span>Для таблиц</span>
              </button>
              <button type="button" onClick={() => exportResults("json")}>
                <strong>JSON</strong>
                <span>Все данные</span>
              </button>
              <button type="button" onClick={() => exportResults("txt")}>
                <strong>TXT</strong>
                <span>Только URL</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {helpOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setHelpOpen(false);
          }}
        >
          <section
            className="modal help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <div className="modal-header">
              <div>
                <span className="mini-label">How it works</span>
                <h2 id="help-title">Проверка без чёрного ящика</h2>
              </div>
              <button
                className="round-button"
                type="button"
                onClick={() => setHelpOpen(false)}
                aria-label="Закрыть справку"
              >
                <X size={18} />
              </button>
            </div>
            <div className="help-steps">
              <article>
                <span>01</span>
                <div>
                  <h3>Подготовка</h3>
                  <p>
                    Ссылки нормализуются, дубликаты объединяются, локальные и
                    служебные адреса блокируются.
                  </p>
                </div>
              </article>
              <article>
                <span>02</span>
                <div>
                  <h3>Запрос</h3>
                  <p>
                    Сначала используется HEAD, затем ограниченный GET для
                    сайтов, которые HEAD не поддерживают.
                  </p>
                </div>
              </article>
              <article>
                <span>03</span>
                <div>
                  <h3>Диагностика</h3>
                  <p>
                    Каждый редирект проверяется отдельно, а результат приходит
                    в интерфейс сразу после ответа URL.
                  </p>
                </div>
              </article>
            </div>
            <div className="help-note">
              <ShieldCheck size={20} />
              <p>
                LinkPulse проверяет доступность, но не обходит страницы как
                crawler и не хранит ваши списки на сервере.
              </p>
            </div>
          </section>
        </div>
      )}

      <div className={`toast ${toast ? "show" : ""}`} role="status">
        <CheckCircle2 size={18} />
        {toast}
      </div>
      <div className="sr-only" aria-live="polite">
        {running
          ? `Проверено ${progress.checked} из ${progress.total}. Ошибок: ${progress.errors}.`
          : ""}
      </div>
    </main>
  );
}
