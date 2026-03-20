const messagesEl = document.getElementById("messages");
const form = document.getElementById("chatForm");
const input = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const userStatusEl = document.getElementById("userStatus");

const accountBtn = document.getElementById("accountBtn");
const uiOverlay = document.getElementById("uiOverlay");
const accountDrawer = document.getElementById("accountDrawer");
const closeAccountDrawer = document.getElementById("closeAccountDrawer");

const showLoginTabBtn = document.getElementById("showLoginTab");
const showRegisterTabBtn = document.getElementById("showRegisterTab");
const loginPanel = document.getElementById("loginPanel");
const registerPanel = document.getElementById("registerPanel");

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const logoutBtn = document.getElementById("logoutBtn");

const loggedInView = document.getElementById("loggedInView");
const guestAuthView = document.getElementById("guestAuthView");
const accountName = document.getElementById("accountName");
const accountEmail = document.getElementById("accountEmail");
const authMessage = document.getElementById("authMessage");

const STORAGE_KEY = "nova-gemini-history-v1";

let history = loadHistory();
let currentUser = null;

switchAuthTab("login");
init();

async function init() {
  await syncCurrentUser();
  renderHistory();
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw || "[]");

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.role === "string" &&
        typeof item.content === "string" &&
        ["user", "assistant"].includes(item.role)
    );
  } catch {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-30)));
}

function createMessage(role, content, extraClass = "") {
  const row = document.createElement("div");
  row.className = "message-row";

  const avatar = document.createElement("div");
  avatar.className = `avatar ${role}`;
  avatar.textContent = role === "assistant" ? "AI" : "VOUS";

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = role === "assistant" ? "Nova Assistant" : "Vous";

  const bubble = document.createElement("div");
  bubble.className = `bubble ${role} ${extraClass}`.trim();
  bubble.textContent = content;

  wrap.appendChild(meta);
  wrap.appendChild(bubble);
  row.appendChild(avatar);
  row.appendChild(wrap);

  return row;
}

function renderHistory() {
  messagesEl.innerHTML = "";

  if (history.length === 0) {
    messagesEl.appendChild(
      createMessage(
        "assistant",
        "Bonjour, je suis Nova Assistant. Pose-moi ta question et je te répondrai de manière claire et professionnelle."
      )
    );
  } else {
    history.forEach((item) => {
      messagesEl.appendChild(createMessage(item.role, item.content));
    });
  }

  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setLoading(isLoading) {
  sendBtn.disabled = isLoading;
  clearBtn.disabled = isLoading;
  input.disabled = isLoading;
  statusEl.textContent = isLoading ? "● Génération..." : "● En ligne";
}

function addTypingIndicator() {
  const node = createMessage("assistant", "Nova écrit...", "typing");
  node.id = "typing-indicator";
  messagesEl.appendChild(node);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
}

function setFeedback(element, text = "", type = "") {
  element.textContent = text;
  element.className = "feedback";
  if (type) element.classList.add(type);
}

function switchAuthTab(tab) {
  const isLogin = tab === "login";

  showLoginTabBtn.classList.toggle("active", isLogin);
  showRegisterTabBtn.classList.toggle("active", !isLogin);
  loginPanel.classList.toggle("is-hidden", !isLogin);
  registerPanel.classList.toggle("is-hidden", isLogin);
  setFeedback(authMessage, "");
}

function updateAccountUI() {
  if (currentUser) {
    userStatusEl.textContent = currentUser.name;
    loggedInView.classList.remove("is-hidden");
    guestAuthView.classList.add("is-hidden");
    accountName.textContent = currentUser.name;
    accountEmail.textContent = currentUser.email;
  } else {
    userStatusEl.textContent = "Invité";
    loggedInView.classList.add("is-hidden");
    guestAuthView.classList.remove("is-hidden");
  }
}

function openOverlay() {
  uiOverlay.classList.remove("is-hidden");
}

function closeOverlay() {
  uiOverlay.classList.add("is-hidden");
}

function openAccountDrawer() {
  openOverlay();
  accountDrawer.classList.add("open");
  accountBtn.classList.add("active");
  accountDrawer.setAttribute("aria-hidden", "false");
}

function closeAccountDrawerFn() {
  accountDrawer.classList.remove("open");
  accountBtn.classList.remove("active");
  accountDrawer.setAttribute("aria-hidden", "true");
  closeOverlay();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Une erreur est survenue.");
  }

  return data;
}

async function syncCurrentUser() {
  try {
    const data = await fetchJson("/api/auth/me", {
      method: "GET",
    });

    currentUser = data.authenticated ? data.user : null;
    updateAccountUI();
  } catch {
    currentUser = null;
    updateAccountUI();
  }
}

async function sendMessage(text) {
  const message = text.trim();
  if (!message) return;

  const previousHistory = history.slice(-12);

  history.push({
    role: "user",
    content: message,
  });

  saveHistory();
  renderHistory();

  input.value = "";
  setLoading(true);
  addTypingIndicator();

  try {
    const data = await fetchJson("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        history: previousHistory,
      }),
    });

    removeTypingIndicator();

    history.push({
      role: "assistant",
      content: data.reply,
    });

    saveHistory();
    renderHistory();
  } catch (error) {
    removeTypingIndicator();

    history.push({
      role: "assistant",
      content:
        "Je rencontre un problème technique. Vérifie la clé Gemini, le fichier .env et la console du serveur.",
    });

    saveHistory();
    renderHistory();
    console.error(error);
  } finally {
    setLoading(false);
    input.focus();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendMessage(input.value);
});

input.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    await sendMessage(input.value);
  }
});

clearBtn.addEventListener("click", () => {
  history = [];
  saveHistory();
  renderHistory();
  input.focus();
});

accountBtn.addEventListener("click", () => {
  setFeedback(authMessage, "");
  openAccountDrawer();
});

closeAccountDrawer.addEventListener("click", closeAccountDrawerFn);
uiOverlay.addEventListener("click", closeAccountDrawerFn);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAccountDrawerFn();
  }
});

showLoginTabBtn.addEventListener("click", () => switchAuthTab("login"));
showRegisterTabBtn.addEventListener("click", () => switchAuthTab("register"));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  setFeedback(authMessage, "");

  try {
    const data = await fetchJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    currentUser = data.user;
    updateAccountUI();
    setFeedback(authMessage, "Connexion réussie.", "success");
    loginForm.reset();
  } catch (error) {
    setFeedback(authMessage, error.message, "error");
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("registerName").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;

  setFeedback(authMessage, "");

  try {
    const data = await fetchJson("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    });

    currentUser = data.user;
    updateAccountUI();
    setFeedback(authMessage, "Compte créé avec succès.", "success");
    registerForm.reset();
  } catch (error) {
    setFeedback(authMessage, error.message, "error");
  }
});

logoutBtn.addEventListener("click", async () => {
  setFeedback(authMessage, "");

  try {
    await fetchJson("/api/auth/logout", {
      method: "POST",
    });

    currentUser = null;
    updateAccountUI();
    setFeedback(authMessage, "Déconnexion réussie.", "success");
  } catch (error) {
    setFeedback(authMessage, error.message, "error");
  }
});