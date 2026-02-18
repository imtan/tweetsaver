const api = typeof browser !== "undefined" ? browser : chrome;
const shortcutBox = document.getElementById("shortcutBox");
const saveBtn = document.getElementById("saveBtn");
const statusMsg = document.getElementById("statusMsg");
const eagleSection = document.getElementById("eagleSection");
const eagleFolderSelect = document.getElementById("eagleFolder");
const eagleStatus = document.getElementById("eagleStatus");

const DEFAULT_SHORTCUT = { altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: "s" };
const EAGLE_API = "http://localhost:41595";

let currentMode = "download"; // "download" | "eagle" | "both"
let currentShortcut = { ...DEFAULT_SHORTCUT };
let recording = false;
let eagleFolders = [];

// ── Load saved settings ──
api.storage.local.get(["saveMode", "eagleFolderId", "shortcut"], (data) => {
  if (data.saveMode) {
    currentMode = data.saveMode;
  }
  if (data.shortcut) {
    currentShortcut = data.shortcut;
  }

  // Update toggle UI
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === currentMode);
  });
  updateEagleSectionVisibility();
  updateShortcutDisplay();

  // Load Eagle folders if needed
  if (currentMode === "eagle" || currentMode === "both") {
    loadEagleFolders(data.eagleFolderId);
  }
});

// ── Mode toggle ──
document.querySelectorAll(".toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentMode = btn.dataset.mode;
    updateEagleSectionVisibility();

    if ((currentMode === "eagle" || currentMode === "both") && eagleFolders.length === 0) {
      loadEagleFolders();
    }
  });
});

function updateEagleSectionVisibility() {
  const show = currentMode === "eagle" || currentMode === "both";
  eagleSection.classList.toggle("visible", show);
}

// ── Eagle folder loading ──
async function loadEagleFolders(selectedId) {
  eagleFolderSelect.innerHTML = '<option value="">読み込み中...</option>';
  eagleStatus.innerHTML = "";

  try {
    const resp = await fetch(`${EAGLE_API}/api/folder/list`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();

    if (json.status === "success" && json.data) {
      eagleFolders = flattenFolders(json.data);
      eagleFolderSelect.innerHTML = '<option value="">（指定なし — ルート）</option>';
      for (const f of eagleFolders) {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.prefix + f.name;
        if (f.id === selectedId) opt.selected = true;
        eagleFolderSelect.appendChild(opt);
      }
      eagleStatus.innerHTML = "";
      const dotOk = document.createElement("span");
      dotOk.className = "dot dot-ok";
      eagleStatus.appendChild(dotOk);
      eagleStatus.appendChild(document.createTextNode(` Eagle 接続OK（${eagleFolders.length} フォルダ）`));
    } else {
      throw new Error("Unexpected response");
    }
  } catch (err) {
    eagleFolderSelect.innerHTML = '<option value="">Eagle に接続できません</option>';
    eagleStatus.innerHTML = "";
    const dotErr = document.createElement("span");
    dotErr.className = "dot dot-err";
    eagleStatus.appendChild(dotErr);
    eagleStatus.appendChild(document.createTextNode(` ${err.message}`));
  }
}

function flattenFolders(folders, depth = 0) {
  const result = [];
  for (const f of folders) {
    const prefix = depth > 0 ? "　".repeat(depth) + "└ " : "";
    result.push({ id: f.id, name: f.name, prefix });
    if (f.children && f.children.length > 0) {
      result.push(...flattenFolders(f.children, depth + 1));
    }
  }
  return result;
}

// ── Shortcut recorder ──
function renderShortcut(sc) {
  const parts = [];
  if (sc.ctrlKey) parts.push("Ctrl");
  if (sc.altKey) parts.push("Alt");
  if (sc.shiftKey) parts.push("Shift");
  if (sc.metaKey) parts.push("Meta");
  let k = sc.key;
  if (k === " ") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.map((p) => `<kbd>${p}</kbd>`).join(" + ");
}

function updateShortcutDisplay() {
  shortcutBox.innerHTML = renderShortcut(currentShortcut);
  shortcutBox.classList.remove("recording");
}

updateShortcutDisplay();

shortcutBox.addEventListener("click", () => {
  recording = true;
  shortcutBox.classList.add("recording");
  shortcutBox.innerHTML = '<span class="placeholder">キーを押してください...</span>';
  shortcutBox.focus();
});

shortcutBox.addEventListener("keydown", (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
  if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    shortcutBox.innerHTML = '<span class="placeholder">修飾キーも一緒に押してください</span>';
    return;
  }
  currentShortcut = {
    ctrlKey: e.ctrlKey, altKey: e.altKey,
    shiftKey: e.shiftKey, metaKey: e.metaKey,
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
  };
  recording = false;
  updateShortcutDisplay();
});

document.addEventListener("click", (e) => {
  if (recording && e.target !== shortcutBox && !shortcutBox.contains(e.target)) {
    recording = false;
    updateShortcutDisplay();
  }
});

// ── Save settings ──
saveBtn.addEventListener("click", () => {
  const settings = {
    saveMode: currentMode,
    shortcut: currentShortcut,
    eagleFolderId: eagleFolderSelect.value || "",
  };
  api.storage.local.set(settings, () => {
    statusMsg.textContent = "保存しました ✓";
    setTimeout(() => (statusMsg.textContent = ""), 2000);
  });
});
