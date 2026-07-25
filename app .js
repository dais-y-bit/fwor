/* ==========================================================================
   GEPT 單字卡 — app.js
   負責：讀取 words.json → 建立卡片 → SM-2 排程 → 畫面切換
   資料只存在瀏覽器的 localStorage，離線就能長期使用，不需要登入或資料庫。
   ========================================================================== */

const STORAGE_KEY = "gept_progress_v1";
const NEW_CARDS_PER_SESSION = 20; // 每次抽屜最多帶出幾張「全新」的卡片

const MODES = [
  { id: "all",   label: "全部",   accent: "var(--moss)",  filter: () => true },
  { id: "basic", label: "初級",   accent: "var(--dusk)",  filter: (e) => e.level === "初級" },
  { id: "inter", label: "中級",   accent: "var(--amber)", filter: (e) => e.level === "中級" },
  { id: "awl",   label: "AWL",   accent: "var(--clay)",  filter: (e) => !!e.awl },
];

let CARDS = [];          // 攤平後的卡片清單（每個 word 的每個詞性各自一張）
let progress = {};       // localStorage 讀出來的排程資料
let session = null;      // 目前進行中的複習 session

// ---------------------------------------------------------------------------
// 啟動流程
// ---------------------------------------------------------------------------

init();
registerServiceWorker();

function registerServiceWorker() {
  // file:// 直接開啟本機檔案時不支援 service worker(必須透過 http/https)，
  // 這裡先判斷一下，避免在還沒上架成網站前，主控台跳一堆用不到的錯誤。
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol === "file:") return;

  navigator.serviceWorker.register("service-worker.js").catch((err) => {
    console.error("Service worker 註冊失敗：", err);
  });
}

async function init() {
  progress = loadProgress();
  CARDS = await loadCards();
  renderDrawers();
  bindGlobalEvents();
}

async function loadCards() {
  // words.js 會在這個檔案載入前，先把資料放進全域變數 GEPT_WORDS
  // (改用這種方式而不是 fetch('words.json')，是因為用 file:// 直接雙擊打開
  //  index.html 時，瀏覽器的 CORS 安全限制會擋掉 fetch 讀取本機檔案)
  const data = GEPT_WORDS;
  const cards = [];
  data.words.forEach((w, wordIdx) => {
    w.entries.forEach((e, entryIdx) => {
      cards.push({
        id: `${wordIdx}-${entryIdx}`,
        word: w.word,
        pos: e.pos.join("/"),
        zh: e.zh,
        aliases: e.aliases.map((a) => a.text),
        level: e.level,
        awl: e.awl,
      });
    });
  });
  return cards;
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("讀取進度失敗，將視為全新開始：", err);
    return {};
  }
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (err) {
    console.error("儲存進度失敗：", err);
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 首頁：抽屜
// ---------------------------------------------------------------------------

function renderDrawers() {
  const grid = document.getElementById("drawer-grid");
  grid.innerHTML = "";

  const today = todayStr();

  MODES.forEach((mode) => {
    const modeCards = CARDS.filter((c) => mode.filter(c));
    const dueCount = modeCards.filter((c) => isDue(c.id, today)).length;

    const drawer = document.createElement("button");
    drawer.className = "drawer";
    drawer.style.setProperty("--drawer-accent", mode.accent);
    drawer.innerHTML = `
      <span class="drawer-label">${mode.label} 抽屜</span>
      <h3>${mode.label}</h3>
      <div class="drawer-meta">
        <span>共 ${modeCards.length} 張</span>
      </div>
      <div class="drawer-due ${dueCount === 0 ? "zero" : ""}">
        ${dueCount === 0 ? "今天沒有待複習的卡片" : `今天待複習 ${dueCount} 張`}
      </div>
    `;
    drawer.addEventListener("click", () => startSession(mode));
    grid.appendChild(drawer);
  });

  const totalDue = CARDS.filter((c) => isDue(c.id, today)).length;
  document.getElementById("total-progress-note").textContent =
    totalDue > 0
      ? `全部抽屜加起來，今天共有 ${totalDue} 張卡片等你複習`
      : "所有抽屜今天都清空了，可以提前複習或休息一下";
}

function isDue(cardId, today) {
  const p = progress[cardId];
  if (!p) return true; // 從沒複習過 = 新卡片，也算「今天可以學」
  return p.due <= today;
}

// ---------------------------------------------------------------------------
// 建立一個複習 session
// ---------------------------------------------------------------------------

function startSession(mode) {
  const today = todayStr();
  const modeCards = CARDS.filter((c) => mode.filter(c));

  const dueCards = modeCards.filter((c) => progress[c.id] && progress[c.id].due <= today);
  const newCards = modeCards
    .filter((c) => !progress[c.id])
    .slice(0, NEW_CARDS_PER_SESSION);

  const queue = shuffle([...dueCards, ...newCards]);

  if (queue.length === 0) {
    // 保底：這個抽屜真的完全沒有卡片可以學
    queue.push(...shuffle(modeCards).slice(0, NEW_CARDS_PER_SESSION));
  }

  session = {
    mode,
    queue,
    totalPlanned: queue.length,
    answered: 0,
    knowCount: 0,
    currentDirection: null,
  };

  document.getElementById("mode-tab").textContent = mode.label;
  showScreen("study");
  showNextCard();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// 翻卡畫面
// ---------------------------------------------------------------------------

function showNextCard() {
  if (!session || session.queue.length === 0) {
    finishSession();
    return;
  }

  const card = session.queue[0];
  const direction = Math.random() < 0.5 ? "zh-front" : "en-front";
  session.currentDirection = direction;

  const cardEl = document.getElementById("flash-card");
  cardEl.classList.remove("is-flipped");

  const frontPos = document.getElementById("front-pos");
  const frontText = document.getElementById("front-text");
  const backPos = document.getElementById("back-pos");
  const backText = document.getElementById("back-text");
  const backAlias = document.getElementById("back-alias");

  if (direction === "zh-front") {
    frontPos.textContent = card.pos;
    frontText.textContent = card.zh;
    backPos.textContent = card.pos;
    backText.textContent = card.word;
    backAlias.textContent = card.aliases.length ? `= ${card.aliases.join(", ")}` : "";
  } else {
    frontPos.textContent = card.pos;
    frontText.textContent = card.word;
    backPos.textContent = card.pos;
    backText.textContent = card.zh;
    backAlias.textContent = card.aliases.length ? `= ${card.aliases.join(", ")}` : "";
  }

  updateProgressBar();
}

function updateProgressBar() {
  const done = session.answered;
  const total = session.totalPlanned;
  const pct = total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
  document.getElementById("progress-fill").style.width = `${pct}%`;
  document.getElementById("progress-count").textContent = `${done} / ${total}`;
}

function flipCard() {
  document.getElementById("flash-card").classList.toggle("is-flipped");
}

// ---------------------------------------------------------------------------
// SM-2 間隔重複演算法
// ---------------------------------------------------------------------------
//
// quality 對應四個按鈕：
//   忘了 -> 0   完全想不起來
//   再練 -> 2   有印象但答錯，需要短期內再看到
//   拼錯 -> 3   意思記得，但拼字/細節有誤，勉強算過關
//   會了 -> 5   很確定，直接答對
//
// quality < 3 視為「這次沒過」：repetitions 歸零，安排很快再複習一次；
// quality >= 3 視為「過關」：依照標準 SM-2 公式拉長下一次複習的間隔天數。

function sm2Update(prev, quality) {
  let ef = prev?.ef ?? 2.5;
  let interval = prev?.interval ?? 0;
  let repetitions = prev?.repetitions ?? 0;

  if (quality < 3) {
    repetitions = 0;
    interval = 1; // 明天再看一次（同一個 session 裡也會提前重新排隊）
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round(interval * ef);
  }

  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) ef = 1.3;

  const due = new Date();
  due.setDate(due.getDate() + Math.max(interval, 0));

  return {
    ef: Number(ef.toFixed(2)),
    interval,
    repetitions,
    due: due.toISOString().slice(0, 10),
    lastReviewed: new Date().toISOString(),
  };
}

function answerCard(quality) {
  if (!session || session.queue.length === 0) return;

  const card = session.queue.shift();
  const prev = progress[card.id];
  progress[card.id] = sm2Update(prev, quality);
  saveProgress();

  session.answered += 1;
  if (quality >= 3) session.knowCount += 1;

  // 答錯(quality < 3) 的卡片，安排在這次 session 裡「稍後」再出現一次，
  // 而不是直接消失，這樣才有練習到的感覺。
  if (quality < 3) {
    const reinsertAt = Math.min(session.queue.length, 3 + Math.floor(Math.random() * 3));
    session.queue.splice(reinsertAt, 0, card);
    session.totalPlanned += 1; // 這張要多算一次，進度條才不會超過 100%
  }

  showNextCard();
}

function finishSession() {
  const total = session.answered;
  const rate = total === 0 ? 0 : Math.round((session.knowCount / total) * 100);

  document.getElementById("done-total").textContent = total;
  document.getElementById("done-rate").textContent = `${rate}%`;
  document.getElementById("done-headline").textContent =
    rate >= 80 ? "做得好，這疊都熟了" : rate >= 50 ? "有進步，明天繼續" : "沒關係，多看幾次就會了";

  session = null;
  showScreen("done");
}

// ---------------------------------------------------------------------------
// 畫面切換 & 事件綁定
// ---------------------------------------------------------------------------

function showScreen(name) {
  ["home", "study", "done"].forEach((n) => {
    document.getElementById(`screen-${n}`).classList.toggle("hidden", n !== name);
  });
  if (name === "home") renderDrawers();
}

function bindGlobalEvents() {
  document.getElementById("flash-card").addEventListener("click", flipCard);

  document.getElementById("answer-bar").addEventListener("click", (evt) => {
    const btn = evt.target.closest(".ans-btn");
    if (!btn) return;
    answerCard(Number(btn.dataset.quality));
  });

  document.getElementById("btn-exit").addEventListener("click", () => {
    session = null;
    showScreen("home");
  });

  document.getElementById("btn-back-home").addEventListener("click", () => {
    showScreen("home");
  });
}
