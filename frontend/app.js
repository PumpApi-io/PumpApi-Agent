// PumpApi Agent - Vue 3 SPA
import { createApp, ref, reactive, computed, onMounted, nextTick, watch, h } from 'vue';
import { marked } from 'marked';
import hljs from 'highlight.js';

// ---- Marked config ----
marked.setOptions({
  breaks: true,
  gfm: true,
});
const renderer = new marked.Renderer();
const origCode = renderer.code.bind(renderer);
renderer.code = function (code, lang) {
  let highlighted = '';
  try {
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(code, { language: lang }).value;
    } else {
      highlighted = hljs.highlightAuto(code).value;
    }
  } catch (e) {
    highlighted = origCode(code, lang);
  }
  return `<pre><code class="hljs language-${lang || ''}">${highlighted}</code></pre>`;
};
marked.use({ renderer });

// Image extensions that should render inline as <img>. Other allowed extensions
// fall back to a "📎 filename" link.
const MEDIA_IMG_EXT = new Set(['png','jpg','jpeg','gif','webp','bmp','svg']);

// Match an assistant-emitted "MEDIA:/abs/path" reference. Stops at whitespace
// or HTML angle brackets so we don't swallow following markup.
const MEDIA_RE = /MEDIA:(\/[^\s<>"']+)/g;

function formatTimestamp(epochSec, withSeconds = false) {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yest.toDateString();
  const sameYear = d.getFullYear() === now.getFullYear();
  const pad = n => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}` + (withSeconds ? `:${pad(d.getSeconds())}` : '');
  if (withSeconds) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${hm}`;
  }
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mon = MONTHS[d.getMonth()];
  if (sameDay) return hm;
  if (isYesterday) return `Yesterday ${hm}`;
  if (sameYear) return `${pad(d.getDate())} ${mon} ${hm}`;
  return `${pad(d.getDate())} ${mon} ${d.getFullYear()} ${hm}`;
}

function mediaToHtml(absPath) {
  const ext = (absPath.match(/\.([a-zA-Z0-9]+)$/) || [,''])[1].toLowerCase();
  const url = `/api/media?path=${encodeURIComponent(absPath)}`;
  const filename = absPath.split('/').pop() || absPath;
  if (MEDIA_IMG_EXT.has(ext)) {
    return `<img class="thumb-img media-attachment" src="${url}" data-fullsrc="${url}" alt="${escapeHtml(filename)}" />`;
  }
  return `<a class="att-pill" href="${url}" target="_blank" rel="noopener">📎 ${escapeHtml(filename)}</a>`;
}

function renderMarkdown(text) {
  if (!text) return '';
  let html;
  try { html = marked.parse(text); } catch (e) { html = escapeHtml(text); }
  // Post-process: replace MEDIA:/abs/path tokens with an inline image or link.
  // Run on the rendered HTML so paths that ended up wrapped in <p>/<code>/etc.
  // still get matched. We deliberately skip matches inside href="..." and
  // src="..." attributes by requiring the token not to be preceded by `="` or `='`.
  return html.replace(/(?<!["'=])MEDIA:(\/[^\s<>"']+)/g, (_m, p) => mediaToHtml(p));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- API client ----
async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error('request failed: ' + res.status);
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// ---- Utility: read file as data URL ----
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---- Tool emoji fallback (api_server already sends one) ----
const TOOL_EMOJI_DEFAULT = '🔧';

// ---- Main App ----
const App = {
  setup() {
    const chats = ref([]);
    const chatsCursor = ref(null);   // pagination cursor for next page (null = no more)
    const chatsLoading = ref(false); // true while fetching a page
    const chatsSearch = ref('');     // current search query
    const chatsTotal = computed(() => chats.value.length);
    const activeChatId = ref(null);
    const messages = ref([]);
    const models = ref([]);
    // selectedModel is hydrated from hermes config (source of truth) in loadModels().
    // We start empty so the dropdown doesn't briefly flash a wrong/stale value.
    const selectedModel = ref('');
    const draft = ref('');
    const draftAttachments = ref([]); // [{kind:'image'|'text', filename, dataUri?, text?, size}]
    const streaming = ref(false);
    const settingsOpen = ref(false);
    const lightboxUrl = ref(null);
    const textPreview = ref(null);
    const confirm = ref(null); // {message, onYes}
    const popoverChatId = ref(null);
    const renamingChatId = ref(null);
    const renameValue = ref('');
    const editingMessageId = ref(null);
    const editingValue = ref('');
    const editingAttachments = ref([]);
    // Per-message expanded/collapsed state for the tool-events block. Default
    // collapsed once the assistant finishes streaming. The currently-streaming
    // bubble shows tools inline regardless.
    const expandedTools = reactive({}); // {messageId: bool}
    const sidebarOpen = ref(false);
    const errorBanner = ref(null);
    const showError = (title, detail) => { errorBanner.value = { title, detail: detail || '', kind: 'error' }; };
    const dismissError = () => { errorBanner.value = null; };
    let toastTimer = null;
    const toast = (text, kind) => {
      errorBanner.value = { title: text, detail: '', kind: kind === 'error' ? 'error' : 'info' };
      if (toastTimer) clearTimeout(toastTimer);
      // auto-dismiss success/info after 3.5s; errors stay until user closes
      if (kind !== 'error') {
        toastTimer = setTimeout(() => {
          if (errorBanner.value && errorBanner.value.kind !== 'error') errorBanner.value = null;
        }, 3500);
      }
    };
    const toggleSidebar = () => { sidebarOpen.value = !sidebarOpen.value; };
    const closeSidebar = () => { sidebarOpen.value = false; };
    const settings = reactive({
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_ALLOWED_USERS: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_ALLOWED_USERS: '',
      WHATSAPP_ACCOUNT_SID: '',
      WHATSAPP_AUTH_TOKEN: '',
      WHATSAPP_FROM_NUMBER: '',
      WHATSAPP_HOME_NUMBER: '',
    });
    const apiKey = ref('');
    const apiKeyVisible = ref(false);

    // ---- Settings hub state ----
    // panel: null = hub view; 'telegram'|'discord'|'whatsapp'|'memory'|'skills'|'tools'|'mcp' = sub-modal
    const panel = ref(null);
    // Memory editor: {target:'MEMORY'|'USER', content, dirty}
    const memEditor = ref(null);
    // Skills list + import form
    const skillsList = ref([]);
    const skillsLoading = ref(false);
    const skillImporter = ref(null); // {source, name, content, url, busy}
    const skillPreview = ref(null);   // {name, content}
    // Tools (built-in toolsets)
    const toolsList = ref([]);
    const toolsLoading = ref(false);
    // MCP servers
    const mcpList = ref([]);
    const mcpEmpty = ref(true);
    const mcpForm = ref(null); // {name, url, busy}

    let abortController = null;
    let pasteCounter = 0;

    const textareaRef = ref(null);
    const chatAreaRef = ref(null);
    const chatsListRef = ref(null);

    // ---- Virtual scroll state for the sidebar chat list ----
    //
    // Renders only the visible window (~20 items) regardless of how many
    // chats exist. Without this, 1000 chats = 1000 DOM nodes = janky scroll.
    //
    // Implementation: fixed-height rows (CHAT_ROW_HEIGHT) + a spacer div sized
    // to the full virtual height + a translateY offset on the visible block.
    // We listen to scroll on .chats-list (chatsListRef) and recompute window
    // indices on every scroll/resize. Buffer of 5 rows above and below to
    // hide pop-in during fast scroll.
    const CHAT_ROW_HEIGHT = 38;        // px — keep in sync with .chat-item CSS
    const CHAT_ROW_BUFFER = 5;
    const chatsScrollTop = ref(0);
    const chatsViewportH = ref(600);

    const visibleChats = computed(() => {
      const total = chats.value.length;
      const viewportH = chatsViewportH.value || 600;
      const start = Math.max(0, Math.floor(chatsScrollTop.value / CHAT_ROW_HEIGHT) - CHAT_ROW_BUFFER);
      const end = Math.min(total, Math.ceil((chatsScrollTop.value + viewportH) / CHAT_ROW_HEIGHT) + CHAT_ROW_BUFFER);
      const items = [];
      for (let i = start; i < end; i++) items.push({ chat: chats.value[i], index: i });
      return { items, start, end, total };
    });

    function onChatsScroll(e) {
      chatsScrollTop.value = e.target.scrollTop;
      // Infinite scroll: when within 200px of the bottom, fetch the next page.
      const el = e.target;
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (remaining < 200 && chatsCursor.value && !chatsLoading.value) {
        loadMoreChats();
      }
    }

    // Recompute viewport height on resize. Cheap: just height of the chats
    // list container, not the whole layout.
    function measureChatsViewport() {
      const el = chatsListRef.value;
      if (el) chatsViewportH.value = el.clientHeight || 600;
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', measureChatsViewport);
    }

    // Streaming state — current assistant message being built
    const liveAssistant = reactive({
      visible: false,
      content: '',
      tools: [], // [{toolCallId, name, emoji, label, status}]
    });

    // ---- Lifecycle ----
    onMounted(async () => {
      await loadModels();
      await loadChats();
      // Measure viewport AFTER the chats list is in the DOM, so the virtual
      // scroll computes a sensible window on first render.
      await nextTick();
      measureChatsViewport();
      // Auto-select most recent or create one
      if (chats.value.length) {
        await openChat(chats.value[0].id);
      } else {
        await newChat();
      }
      document.addEventListener('keydown', onGlobalKey);
      document.addEventListener('click', onGlobalClick);
    });

    function onGlobalKey(e) {
      if (e.key === 'Escape') {
        if (lightboxUrl.value) lightboxUrl.value = null;
        else if (textPreview.value) textPreview.value = null;
        else if (skillPreview.value) skillPreview.value = null;
        else if (skillImporter.value && !skillImporter.value.busy) skillImporter.value = null;
        else if (mcpForm.value && !mcpForm.value.busy) mcpForm.value = null;
        else if (memEditor.value) memEditor.value = null;
        else if (panel.value) panel.value = null;
        else if (settingsOpen.value) settingsOpen.value = false;
        else if (confirm.value) confirm.value = null;
        else if (popoverChatId.value) popoverChatId.value = null;
      }
    }
    function onGlobalClick(e) {
      // close popovers when clicking outside
      if (popoverChatId.value && !e.target.closest('.chat-item')) {
        popoverChatId.value = null;
      }
    }

    async function loadModels() {
      try {
        // Fetch list and current selection in parallel. Current model comes
        // from hermes config (model.default), not localStorage — config is
        // the only thing api_server actually reads at startup.
        const [m, cur] = await Promise.all([api('/api/models'), api('/api/model')]);
        if (Array.isArray(m) && m.length) models.value = m;
        const fromCfg = (cur && cur.model) || '';
        if (fromCfg) {
          selectedModel.value = fromCfg;
        } else if (models.value.length) {
          selectedModel.value = models.value[0].id;
        }
      } catch (e) { /* ignore */ }
    }

    // Switching model rewrites hermes config + restarts the hermes-gateway,
    // because api_server reads model.default once at startup. Any in-flight
    // streams get killed by the gateway restart, so we warn the user first.
    function onModelChange(e) {
      const newModel = e.target.value;
      const prev = selectedModel.value;
      if (newModel === prev) return;
      e.target.value = prev; // keep dropdown on old value until user confirms
      const warn = streaming.value
        ? `Switching the model will restart the agent and abort the response that's currently being generated. The new model also applies to every linked messenger (Telegram / Discord / WhatsApp). Continue?`
        : `Switching the model will briefly restart the agent (a few seconds) and apply to every linked messenger (Telegram / Discord / WhatsApp). Continue?`;
      confirm.value = {
        message: warn,
        confirmLabel: 'Switch',
        danger: false,
        onYes: async () => {
          confirm.value = null;
          if (streaming.value) abortStream();
          selectedModel.value = newModel;
          try {
            await api('/api/model', { method: 'POST', body: JSON.stringify({ model: newModel }) });
            toast(`Model switched to ${newModel}`);
          } catch (err) {
            toast(`Failed to switch model: ${err.message || err}`, 'error');
            selectedModel.value = prev;
          }
        },
      };
    }

    // ---- Chat list pagination + search ----
    //
    // Replaces the old "load all chats at once" pattern. The sidebar fetches
    // pages of CHATS_PAGE_SIZE via cursor pagination; reload-on-every-action
    // is gone — pin/rename/new-chat update the local list optimistically, and
    // a one-shot `refreshChat(id)` syncs a single row from the server when
    // needed (e.g. after the assistant turn updates `updated_at`).
    const CHATS_PAGE_SIZE = 50;

    async function loadChats({ reset = true, query = null } = {}) {
      // `query=null` means "use whatever's in chatsSearch right now". Pass
      // an explicit '' to clear, or a string to override.
      if (query !== null) chatsSearch.value = query;
      if (reset) {
        chats.value = [];
        chatsCursor.value = null;
      }
      if (chatsLoading.value) return;
      chatsLoading.value = true;
      try {
        const params = new URLSearchParams({ limit: String(CHATS_PAGE_SIZE) });
        if (chatsSearch.value) params.set('q', chatsSearch.value);
        const r = await api('/api/chats?' + params.toString());
        chats.value = r.items || [];
        chatsCursor.value = r.next_cursor || null;
      } finally {
        chatsLoading.value = false;
      }
    }

    async function loadMoreChats() {
      if (!chatsCursor.value || chatsLoading.value) return;
      chatsLoading.value = true;
      try {
        const params = new URLSearchParams({
          limit: String(CHATS_PAGE_SIZE),
          cursor: chatsCursor.value,
        });
        if (chatsSearch.value) params.set('q', chatsSearch.value);
        const r = await api('/api/chats?' + params.toString());
        // Dedupe defensively in case the cursor races against an updated_at
        // bump (a chat could shift pages between requests).
        const seen = new Set(chats.value.map(c => c.id));
        for (const it of (r.items || [])) if (!seen.has(it.id)) chats.value.push(it);
        chatsCursor.value = r.next_cursor || null;
      } finally {
        chatsLoading.value = false;
      }
    }

    // Debounced search. Refetch from page 1 ~250ms after the user stops typing.
    let searchTimer = null;
    watch(chatsSearch, () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadChats({ reset: true }), 250);
    });

    // Refresh a single chat row by id. Used after the assistant turn finishes
    // so the chat's `updated_at` (and thus its position in the list) reflects
    // the new activity, without reloading 1000 unrelated rows.
    async function refreshChat(id) {
      if (!id) return;
      try {
        const fresh = await api(`/api/chats/${id}`);
        if (!fresh || !fresh.id) return;
        const idx = chats.value.findIndex(c => c.id === id);
        if (idx === -1) {
          // Chat just appeared in the list (first user message landed). Slot
          // it in at its sorted position.
          insertChatSorted(fresh);
        } else {
          // Update fields and re-sort if pinned/updated_at changed.
          chats.value[idx] = { ...chats.value[idx], ...fresh };
          // Move to correct position by re-inserting.
          const [item] = chats.value.splice(idx, 1);
          insertChatSorted(item);
        }
      } catch (e) { /* ignore — sidebar drift is non-fatal */ }
    }

    // Insert a chat into chats.value at the correct sorted index, matching
    // the backend's ORDER BY pinned DESC, updated_at DESC, id DESC.
    function insertChatSorted(chat) {
      const cmp = (a, b) => {
        const ap = a.pinned ? 1 : 0, bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const au = a.updated_at || 0, bu = b.updated_at || 0;
        if (au !== bu) return bu - au;
        return (b.id || '').localeCompare(a.id || '');
      };
      // Find first index where existing chat should come AFTER new chat
      // (cmp > 0). Insert there.
      let lo = 0, hi = chats.value.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cmp(chats.value[mid], chat) <= 0) lo = mid + 1;
        else hi = mid;
      }
      chats.value.splice(lo, 0, chat);
    }

    // Polls the active chat's messages so a tab that reloaded mid-stream
    // catches up to the still-running generation in the backend. Stops when
    // the last assistant message stops growing for N polls, or when the user
    // navigates away. One handle, replaced on each openChat.
    let pollHandle = null;
    function stopPolling() {
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    }
    function startPollingFor(chatId) {
      stopPolling();
      let lastLen = -1;
      let stableTicks = 0;
      let ticks = 0;
      pollHandle = setInterval(async () => {
        ticks += 1;
        if (activeChatId.value !== chatId || streaming.value || ticks > 600) {
          stopPolling();
          return;
        }
        try {
          const ms = await api(`/api/chats/${chatId}/messages`);
          messages.value = ms;
          const last = ms[ms.length - 1];
          if (!last || last.role !== 'assistant') { stopPolling(); return; }
          const len = (last.content || '').length;
          if (len === lastLen) {
            stableTicks += 1;
            if (stableTicks >= 3) stopPolling();
          } else {
            stableTicks = 0;
            lastLen = len;
          }
        } catch (e) { /* keep trying */ }
      }, 1000);
    }

    async function openChat(id) {
      stopPolling();
      activeChatId.value = id;
      sidebarOpen.value = false;
      messages.value = [];
      liveAssistant.visible = false;
      liveAssistant.content = '';
      liveAssistant.tools = [];
      try {
        const ms = await api(`/api/chats/${id}/messages`);
        messages.value = ms;
        await nextTick();
        scrollToBottom();
        // If the tail is an assistant message that may still be streaming on
        // the backend (recent + reasonable length is allowed to grow), poll
        // until it stops changing.
        const last = ms[ms.length - 1];
        if (last && last.role === 'assistant' && (Date.now() / 1000 - (last.created_at || 0) < 300)) {
          startPollingFor(id);
        }
      } catch (e) { /* ignore */ }
    }

    async function newChat() {
      const r = await api('/api/chats', { method: 'POST', body: JSON.stringify({ model: selectedModel.value }) });
      activeChatId.value = r.id;
      sidebarOpen.value = false;
      messages.value = [];
      liveAssistant.visible = false;
      liveAssistant.content = '';
      liveAssistant.tools = [];
      // chat won't appear in list until first user message lands (backend filters)
    }

    function scrollToBottom() {
      const el = chatAreaRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    }

    // ---- Sidebar actions ----
    // All actions update the local list optimistically and only re-fetch the
    // ONE chat that changed if needed. Avoids reloading hundreds of rows for
    // a single pin/rename.
    async function pinChat(c) {
      const newPinned = !c.pinned;
      // Optimistic: flip the flag and re-sort locally.
      const idx = chats.value.findIndex(x => x.id === c.id);
      if (idx !== -1) {
        chats.value[idx].pinned = newPinned;
        const [item] = chats.value.splice(idx, 1);
        insertChatSorted(item);
      }
      popoverChatId.value = null;
      try {
        await api(`/api/chats/${c.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: newPinned }) });
      } catch (e) {
        // Revert on failure.
        if (idx !== -1) {
          const i2 = chats.value.findIndex(x => x.id === c.id);
          if (i2 !== -1) {
            chats.value[i2].pinned = !newPinned;
            const [item] = chats.value.splice(i2, 1);
            insertChatSorted(item);
          }
        }
      }
    }
    function startRename(c) {
      renamingChatId.value = c.id;
      renameValue.value = c.title;
      popoverChatId.value = null;
    }
    async function commitRename(c) {
      const t = renameValue.value.trim();
      if (t && t !== c.title) {
        // Optimistic local update.
        const idx = chats.value.findIndex(x => x.id === c.id);
        const prev = idx !== -1 ? chats.value[idx].title : c.title;
        if (idx !== -1) chats.value[idx].title = t;
        try {
          await api(`/api/chats/${c.id}`, { method: 'PATCH', body: JSON.stringify({ title: t }) });
        } catch (e) {
          if (idx !== -1) chats.value[idx].title = prev;
        }
      }
      renamingChatId.value = null;
    }
    function cancelRename() { renamingChatId.value = null; }

    function deleteChatPrompt(c) {
      popoverChatId.value = null;
      confirm.value = {
        message: `Delete chat "${c.title || 'Untitled'}"? This cannot be undone.`,
        onYes: async () => {
          // Optimistic remove from local list.
          const idx = chats.value.findIndex(x => x.id === c.id);
          let removed = null;
          if (idx !== -1) {
            removed = chats.value.splice(idx, 1)[0];
          }
          try {
            await api(`/api/chats/${c.id}`, { method: 'DELETE' });
          } catch (e) {
            if (removed) insertChatSorted(removed);
            confirm.value = null;
            return;
          }
          if (activeChatId.value === c.id) {
            if (chats.value.length) openChat(chats.value[0].id);
            else newChat();
          }
          confirm.value = null;
        },
      };
    }

    // ---- Send / Stream ----
    function autoResize() {
      const ta = textareaRef.value;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.2) + 'px';
    }
    watch(draft, () => nextTick(autoResize));

    async function onPaste(e) {
      const items = e.clipboardData?.items || [];
      let handled = false;
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f && f.type.startsWith('image/')) {
            e.preventDefault();
            await attachFile(f);
            handled = true;
          }
        }
      }
      if (handled) return;
      const text = e.clipboardData?.getData('text');
      if (text && text.length > 2000) {
        e.preventDefault();
        pasteCounter += 1;
        draftAttachments.value.push({
          kind: 'text',
          filename: `pasted-text-${pasteCounter}.txt`,
          text,
          size: text.length,
        });
      }
    }

    async function attachFile(file) {
      if (file.type.startsWith('image/')) {
        const dataUri = await fileToDataURL(file);
        draftAttachments.value.push({
          kind: 'image',
          filename: file.name || `image-${Date.now()}.png`,
          dataUri,
          size: file.size,
          mime: file.type,
        });
      } else {
        const text = await file.text();
        draftAttachments.value.push({
          kind: 'text',
          filename: file.name || `file-${Date.now()}.txt`,
          text,
          size: text.length,
        });
      }
    }

    function pickFile() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*,text/*,.md,.json,.csv,.log,.py,.js,.ts';
      inp.onchange = async () => {
        for (const f of inp.files) await attachFile(f);
      };
      inp.click();
    }

    function removeAttachment(idx) { draftAttachments.value.splice(idx, 1); }

    function openTextPreview(att, field, editable) {
      textPreview.value = {
        filename: att.filename,
        content: att[field] || '',
        target: editable ? att : null,
        field,
        size: att.size,
      };
    }
    function saveTextPreview() {
      const p = textPreview.value;
      if (!p || !p.target) return;
      p.target[p.field] = p.content;
      p.target.size = (p.content || '').length;
      textPreview.value = null;
    }

    function onKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (streaming.value) abortStream();
        else send();
      }
    }

    function abortStream() {
      if (abortController) abortController.abort();
    }

    async function send() {
      const text = draft.value.trim();
      if (!text && draftAttachments.value.length === 0) return;
      if (streaming.value) return;

      // Build message payload for backend
      const attachments = draftAttachments.value.map((a) => {
        if (a.kind === 'image') {
          return { type: 'image', filename: a.filename, data_uri: a.dataUri, size: a.size };
        } else {
          return { type: 'text', filename: a.filename, preview: a.text, size: a.size };
        }
      });

      // Optimistic UI: push user message
      const userMsg = {
        id: 'tmp-' + Date.now(),
        role: 'user',
        content: text,
        attachments,
      };
      messages.value.push(userMsg);
      draft.value = '';
      draftAttachments.value = [];
      autoResize();
      await nextTick();
      scrollToBottom();

      await streamAssistantTurn({ message: { content: text, attachments } });
    }

    // Run an assistant streaming turn against /api/chat/stream. Two modes:
    //  - normal: pass {message:{content,attachments}} → backend inserts a new
    //    user message at the active leaf, then streams the assistant.
    //  - branch:  pass {assistantForUserId} → backend skips the user insert
    //    and streams the assistant turn for that existing user message.
    async function streamAssistantTurn({ message, assistantForUserId } = {}) {
      streaming.value = true;
      liveAssistant.visible = true;
      liveAssistant.content = '';
      liveAssistant.tools = [];
      errorBanner.value = null;

      const reqBody = {
        chat_id: activeChatId.value,
        model: selectedModel.value,
      };
      if (message) reqBody.message = message;
      if (assistantForUserId) {
        reqBody.assistant_for_user_id = assistantForUserId;
        // backend ignores `message` in this mode; pass empty for safety
        reqBody.message = { content: '', attachments: [] };
      }

      abortController = new AbortController();
      try {
        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(reqBody),
          signal: abortController.signal,
        });
        if (!res.ok) {
          let detail = '';
          try {
            const errBody = await res.json();
            detail = errBody.detail || errBody.error || JSON.stringify(errBody);
          } catch (_) {
            try { detail = await res.text(); } catch (_) {}
          }
          showError(`HTTP ${res.status} ${res.statusText || ''}`.trim(), detail);
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleSSEBlock(block);
          }
          await nextTick();
          scrollToBottom();
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('stream error', e);
          if (!errorBanner.value) {
            showError('Connection error', e.message || String(e));
          }
        }
      } finally {
        streaming.value = false;
        abortController = null;
        const gotContent = (liveAssistant.content || '').trim().length > 0;
        if (!gotContent && !errorBanner.value) {
          showError(
            'No response from agent',
            'Please check your LLM Balance in your personal account at pumpapi.ai',
          );
        }
        try {
          const ms = await api(`/api/chats/${activeChatId.value}/messages`);
          messages.value = ms;
        } catch (e) {}
        liveAssistant.visible = false;
        liveAssistant.content = '';
        liveAssistant.tools = [];
        // Sync the one chat whose updated_at + maybe title just changed.
        // Cheap: single row vs. reloading the whole list.
        await refreshChat(activeChatId.value);
        await nextTick();
        scrollToBottom();
      }
    }

    function handleSSEBlock(block) {
      let event = 'message';
      let dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        // ignore comments / keepalives
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      if (event === 'hermes.tool.progress') {
        try {
          const obj = JSON.parse(data);
          const id = obj.toolCallId;
          if (!id) return;
          const idx = liveAssistant.tools.findIndex(t => t.toolCallId === id);
          if (obj.status === 'running') {
            if (idx === -1) {
              liveAssistant.tools.push({
                toolCallId: id,
                name: obj.tool || '',
                emoji: obj.emoji || TOOL_EMOJI_DEFAULT,
                label: obj.label || obj.tool || '',
                status: 'running',
              });
            }
          } else if (obj.status === 'completed') {
            if (idx >= 0) liveAssistant.tools[idx].status = 'completed';
          }
        } catch (e) {}
        return;
      }
      if (event === 'error') {
        try {
          const obj = JSON.parse(data);
          showError(obj.error || 'Stream error', obj.detail || '');
        } catch (e) {
          showError('Stream error', data);
        }
        return;
      }
      // default: chat.completion.chunk
      if (data === '[DONE]') return;
      try {
        const obj = JSON.parse(data);
        const choices = obj.choices || [];
        if (choices.length) {
          const delta = choices[0].delta || {};
          if (typeof delta.content === 'string') {
            liveAssistant.content += delta.content;
          }
        }
      } catch (e) {}
    }

    // ---- Edit message ----
    function startEdit(m) {
      editingMessageId.value = m.id;
      editingValue.value = m.content;
      // Deep copy attachments so ✕ removals are draft-only until Save & resend
      editingAttachments.value = (m.attachments || []).map(a => ({ ...a }));
    }
    function cancelEdit() {
      editingMessageId.value = null;
      editingAttachments.value = [];
    }
    async function saveEdit(m) {
      const newText = editingValue.value;
      const newAtts = editingAttachments.value.slice();
      const idx = messages.value.findIndex(x => x.id === m.id);
      if (idx < 0) return;
      // Branching: create a new VERSION of this user message; the old branch
      // (and all replies under it) is preserved and reachable via the < n/N >
      // arrows under the message bubble.
      let resp;
      try {
        resp = await api(`/api/messages/${m.id}/branch`, {
          method: 'POST',
          body: JSON.stringify({ content: newText, attachments: newAtts }),
        });
      } catch (e) {
        showError('Failed to create branch', e.message || String(e));
        return;
      }
      // Optimistic UI: replace the active chain from this index with just the
      // new user version. Assistant turn appends momentarily.
      const newSiblings = [...(m.versions || [m.id]), resp.id];
      messages.value = messages.value.slice(0, idx).concat([{
        ...m,
        id: resp.id,
        content: newText,
        attachments: newAtts,
        version_count: newSiblings.length,
        version_index: newSiblings.length - 1,
        versions: newSiblings,
      }]);
      editingMessageId.value = null;
      editingAttachments.value = [];
      await streamAssistantTurn({ assistantForUserId: resp.id });
    }

    // Removes from the EDITING DRAFT only (not committed until Save & resend).
    function removeEditAttachment(_m, idx) {
      editingAttachments.value.splice(idx, 1);
    }

    // ---- Branch navigation ----
    // Click "<" or ">" under a message to switch to the previous/next sibling
    // version. Calls /api/messages/{id}/select on the backend, then reloads the
    // active chain so the assistant reply (and everything downstream) updates.
    async function switchVersion(m, delta) {
      if (!m.versions || m.versions.length < 2) return;
      const cur = m.version_index ?? 0;
      const next = cur + delta;
      if (next < 0 || next >= m.versions.length) return;
      const targetId = m.versions[next];
      try {
        await api(`/api/messages/${targetId}/select`, { method: 'POST' });
      } catch (e) {
        showError('Failed to switch version', e.message || String(e));
        return;
      }
      // Reload the whole active chain
      try {
        const ms = await api(`/api/chats/${activeChatId.value}/messages`);
        messages.value = ms;
      } catch (e) {}
      await nextTick();
      scrollToBottom();
    }

    // ---- Tool block expand/collapse ----
    function toggleTools(m) {
      const id = m.id;
      expandedTools[id] = !expandedTools[id];
    }
    function isToolsExpanded(m) {
      return !!expandedTools[m.id];
    }

    // ---- Copy message text to clipboard ----
    async function copyMessage(m) {
      const text = m.content || '';
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied');
      } catch (e) {
        // Fallback for non-secure contexts / older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('Copied'); }
        catch (_) { toast('Copy failed', 'error'); }
        document.body.removeChild(ta);
      }
    }

    // Delegated click handler for the chat area: when the user clicks on an
    // inline MEDIA: image rendered via v-html, open it in the lightbox.
    function onChatClick(ev) {
      const t = ev.target;
      if (t && t.tagName === 'IMG' && t.classList.contains('media-attachment')) {
        const url = t.getAttribute('data-fullsrc') || t.getAttribute('src');
        if (url) lightboxUrl.value = url;
      }
    }

    // ---- Settings ----
    async function openSettings() {
      try {
        const cur = await api('/api/settings');
        for (const k of Object.keys(settings)) {
          settings[k] = cur[k] || '';
        }
        const me = await api('/api/me');
        apiKey.value = me.api_key || '';
      } catch (e) {}
      panel.value = null;
      settingsOpen.value = true;
    }

    // Save a subset of settings keys (used by per-platform sub-modals). We POST
    // ALL settings — backend only restarts the gateway if a value actually
    // changed, so this is safe to call from any panel.
    async function saveSection(label) {
      try {
        const r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ ...settings }) });
        const changed = (r && r.updated) || [];
        const restarted = (r && r.restarted) || [];
        if (changed.length === 0) {
          toast('No changes');
        } else if (restarted.length) {
          toast(`${label} saved · gateway restarted`);
        } else if (r && r.restart_errors) {
          toast(`Saved, but gateway restart failed`, 'error');
        } else {
          toast(`${label} saved`);
        }
        panel.value = null;
      } catch (e) {
        toast(`Save failed: ${e.message || e}`, 'error');
      }
    }

    // ---- Messenger connection status ----
    // A messenger is "linked" if its primary required field is non-empty.
    const messengerStatus = computed(() => ({
      telegram: !!settings.TELEGRAM_BOT_TOKEN,
      discord:  !!settings.DISCORD_BOT_TOKEN,
      whatsapp: !!(settings.WHATSAPP_ACCOUNT_SID && settings.WHATSAPP_AUTH_TOKEN),
    }));

    // ---- Memory editor ----
    async function openMemory(target) {
      try {
        const r = await api(`/api/memory/${target}`);
        memEditor.value = { target, content: r.content || '', original: r.content || '' };
        panel.value = 'memory';
      } catch (e) {
        toast(`Failed to load: ${e.message || e}`, 'error');
      }
    }
    async function saveMemory() {
      const m = memEditor.value;
      if (!m) return;
      try {
        await api(`/api/memory/${m.target}`, { method: 'PUT', body: JSON.stringify({ content: m.content }) });
        toast('Memory saved');
        memEditor.value = null;
      } catch (e) {
        toast(`Save failed: ${e.message || e}`, 'error');
      }
    }

    // ---- Skills ----
    async function openSkills() {
      panel.value = 'skills';
      skillsLoading.value = true;
      try {
        const r = await api('/api/skills');
        skillsList.value = r.items || [];
      } catch (e) {
        toast(`Failed to load skills: ${e.message || e}`, 'error');
      } finally {
        skillsLoading.value = false;
      }
    }
    async function viewSkill(name) {
      try {
        const r = await api(`/api/skills/${encodeURIComponent(name)}`);
        // Track original separately so we can detect "dirty" state and confirm
        // discarding edits — and so non-bundled skills become editable in place.
        skillPreview.value = {
          name,
          content: r.content || '',
          original: r.content || '',
          editable: !!r.editable,
          saving: false,
        };
      } catch (e) {
        toast(`Failed to load skill: ${e.message || e}`, 'error');
      }
    }
    async function saveSkillEdit() {
      const p = skillPreview.value;
      if (!p || p.saving || !p.editable) return;
      p.saving = true;
      try {
        await api(`/api/skills/${encodeURIComponent(p.name)}`, {
          method: 'PUT',
          body: JSON.stringify({ content: p.content }),
        });
        toast('Skill saved');
        p.original = p.content;
        skillPreview.value = null;
      } catch (e) {
        toast(`Save failed: ${e.message || e}`, 'error');
      } finally {
        if (skillPreview.value) skillPreview.value.saving = false;
      }
    }
    function closeSkillPreview() {
      const p = skillPreview.value;
      if (p && p.editable && p.content !== p.original) {
        confirm.value = {
          message: 'Discard unsaved changes?',
          confirmLabel: 'Discard',
          onYes: () => { confirm.value = null; skillPreview.value = null; },
        };
        return;
      }
      skillPreview.value = null;
    }
    function startSkillImport() {
      skillImporter.value = { source: 'paste', name: '', content: '', url: '', busy: false };
    }
    async function submitSkillImport() {
      const f = skillImporter.value;
      if (!f || f.busy) return;
      f.busy = true;
      try {
        const body = f.source === 'paste'
          ? { source: 'paste', name: f.name.trim(), content: f.content }
          : { source: 'github', url: f.url.trim() };
        await api('/api/skills', { method: 'POST', body: JSON.stringify(body) });
        toast('Skill installed');
        skillImporter.value = null;
        await openSkills(); // refresh list
      } catch (e) {
        toast(`Install failed: ${e.message || e}`, 'error');
      } finally {
        if (skillImporter.value) skillImporter.value.busy = false;
      }
    }
    function deleteSkill(name) {
      confirm.value = {
        message: `Delete skill "${name}"? This removes the local copy; hub skills can be reinstalled.`,
        onYes: async () => {
          // Close confirm + drop from list optimistically — request can take
          // a while (gateway restart), don't make the user stare at a frozen modal.
          confirm.value = null;
          const prev = skillsList.value;
          skillsList.value = prev.filter(s => s.name !== name);
          try {
            await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
            toast('Skill removed');
          } catch (e) {
            skillsList.value = prev;  // rollback on failure
            toast(`Delete failed: ${e.message || e}`, 'error');
          }
        },
      };
    }

    // ---- Tools ----
    async function openTools() {
      panel.value = 'tools';
      toolsLoading.value = true;
      try {
        const r = await api('/api/tools');
        toolsList.value = r.items || [];
      } catch (e) {
        toast(`Failed to load tools: ${e.message || e}`, 'error');
      } finally {
        toolsLoading.value = false;
      }
    }
    async function toggleTool(t) {
      const target = !t.enabled;
      // Optimistic update — revert on failure
      t.enabled = target;
      try {
        await api('/api/tools/toggle', { method: 'POST', body: JSON.stringify({ name: t.name, enable: target }) });
      } catch (e) {
        t.enabled = !target;
        toast(`Failed: ${e.message || e}`, 'error');
      }
    }

    // ---- MCP ----
    async function openMcp() {
      panel.value = 'mcp';
      try {
        const r = await api('/api/mcp');
        mcpList.value = r.servers || [];
        mcpEmpty.value = !!r.empty;
      } catch (e) {
        toast(`Failed to load: ${e.message || e}`, 'error');
      }
    }
    // Optional preset args — DeepWiki tile pre-fills the form so the user
    // can just hit Add. Empty call = blank form.
    function startMcpAdd(name, url) {
      mcpForm.value = { name: name || '', url: url || '', busy: false };
    }
    async function submitMcpAdd() {
      const f = mcpForm.value;
      if (!f || f.busy) return;
      f.busy = true;
      try {
        const r = await api('/api/mcp', { method: 'POST', body: JSON.stringify({ name: f.name.trim(), url: f.url.trim() }) });
        toast(r.restarted ? 'MCP server added (agent restarted)' : 'MCP server added');
        mcpForm.value = null;
        await openMcp();
      } catch (e) {
        toast(`Add failed: ${e.message || e}`, 'error');
      } finally {
        if (mcpForm.value) mcpForm.value.busy = false;
      }
    }
    function removeMcp(name) {
      confirm.value = {
        message: `Remove MCP server "${name}"?`,
        onYes: async () => {
          confirm.value = null;
          const prev = mcpList.value;
          mcpList.value = prev.filter(s => (s.name || s) !== name);
          mcpEmpty.value = !mcpList.value.length;
          try {
            const r = await api(`/api/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
            toast(r.restarted ? 'Removed (agent restarted)' : 'Removed');
          } catch (e) {
            mcpList.value = prev;
            mcpEmpty.value = !prev.length;
            toast(`Remove failed: ${e.message || e}`, 'error');
          }
        },
      };
    }

    // ---- Render helpers ----
    function maskedKey(k) {
      if (!k) return '';
      return apiKeyVisible.value ? k : '•'.repeat(Math.max(8, k.length));
    }

    async function onDrop(e) {
      const files = e.dataTransfer?.files || [];
      for (const f of files) await attachFile(f);
    }

    return {
      // state
      chats, activeChatId, messages, models, selectedModel, draft, draftAttachments,
      streaming, settingsOpen, lightboxUrl, textPreview, confirm,
      popoverChatId, renamingChatId, renameValue,
      editingMessageId, editingValue,
      settings, apiKey, apiKeyVisible,
      // settings hub
      panel, messengerStatus,
      memEditor, openMemory, saveMemory,
      skillsList, skillsLoading, skillImporter, skillPreview,
      openSkills, viewSkill, saveSkillEdit, closeSkillPreview, startSkillImport, submitSkillImport, deleteSkill,
      toolsList, toolsLoading, openTools, toggleTool,
      mcpList, mcpEmpty, mcpForm, openMcp, startMcpAdd, submitMcpAdd, removeMcp,
      liveAssistant,
      textareaRef, chatAreaRef,
      // chat-list pagination + virtual scroll
      chatsCursor, chatsLoading, chatsSearch, chatsTotal,
      chatsListRef, visibleChats,
      CHAT_ROW_HEIGHT,
      onChatsScroll, loadMoreChats,
      // methods
      newChat, openChat, pinChat, startRename, commitRename, cancelRename,
      deleteChatPrompt, send, abortStream, onKeydown, onPaste,
      pickFile, removeAttachment, autoResize, attachFile, onDrop,
      formatTimestamp,
      openTextPreview, saveTextPreview,
      startEdit, cancelEdit, saveEdit, removeEditAttachment,
      editingAttachments, onChatClick,
      sidebarOpen, toggleSidebar, closeSidebar,
      errorBanner, dismissError,
      openSettings, saveSection, maskedKey,
      renderMarkdown, escapeHtml,
      switchVersion, toggleTools, isToolsExpanded,
      onModelChange, copyMessage,
    };
  },

  template: `
    <div class="app" :class="{ 'sidebar-open': sidebarOpen }" @drop.prevent="onDrop" @dragover.prevent>
      <!-- Mobile backdrop -->
      <div class="sidebar-backdrop" @click="closeSidebar"></div>
      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="brand"><img class="brand-logo" src="/assets/logo.webp" alt="" /> PumpApi Agent</div>
        </div>
        <div style="padding: 10px 12px;">
          <button class="new-chat-btn" @click="newChat">+ New chat</button>
        </div>
        <div class="chats-search">
          <input class="chats-search-input" type="text"
                 placeholder="Search chats..."
                 v-model="chatsSearch" />
          <button v-if="chatsSearch" class="chats-search-clear"
                  @click="chatsSearch = ''" title="Clear">✕</button>
        </div>
        <!--
          Virtual scroll. Outer .chats-list is the scroll container. Inner
          spacer matches total virtual height (rows * CHAT_ROW_HEIGHT). The
          rendered window is absolutely positioned via translateY = start * row.
          Only ~20 rows are in the DOM regardless of total count.
        -->
        <div class="chats-list" ref="chatsListRef" @scroll.passive="onChatsScroll">
          <div class="chats-spacer" :style="{ height: (visibleChats.total * CHAT_ROW_HEIGHT) + 'px' }">
            <div class="chats-window" :style="{ transform: 'translateY(' + (Math.floor(visibleChats.items[0]?.index || 0) * CHAT_ROW_HEIGHT) + 'px)' }">
              <div v-for="entry in visibleChats.items" :key="entry.chat.id"
                   class="chat-item" :class="{ active: entry.chat.id === activeChatId }"
                   :style="{ height: CHAT_ROW_HEIGHT + 'px' }"
                   @click="renamingChatId !== entry.chat.id && openChat(entry.chat.id)">
                <span v-if="entry.chat.pinned" class="pin-icon">📌</span>
                <input v-if="renamingChatId === entry.chat.id" class="rename-input"
                       v-model="renameValue"
                       @keydown.enter="commitRename(entry.chat)"
                       @keydown.esc="cancelRename"
                       @blur="commitRename(entry.chat)"
                       @click.stop ref="renameRef" />
                <span v-else class="chat-title">{{ entry.chat.title || 'Untitled' }}</span>
                <button class="chat-menu-btn" @click.stop="popoverChatId = popoverChatId === entry.chat.id ? null : entry.chat.id">⋮</button>
                <div v-if="popoverChatId === entry.chat.id" class="popover" @click.stop>
                  <button @click="pinChat(entry.chat)">{{ entry.chat.pinned ? 'Unpin' : 'Pin' }}</button>
                  <button @click="startRename(entry.chat)">Rename</button>
                  <button class="danger" @click="deleteChatPrompt(entry.chat)">Delete</button>
                </div>
              </div>
            </div>
          </div>
          <div v-if="chatsLoading" class="chats-loading">Loading…</div>
          <div v-else-if="!chats.length && chatsSearch" class="chats-empty">No chats match "{{ chatsSearch }}"</div>
        </div>
      </aside>

      <!-- Main -->
      <main class="main">
        <div class="header">
          <button class="icon-btn hamburger-btn" title="Menu" @click="toggleSidebar">☰</button>
          <select class="model-select" :value="selectedModel" @change="onModelChange">
            <option v-for="m in models" :key="m.id" :value="m.id">{{ m.id }}</option>
          </select>
          <div class="spacer"></div>
          <button class="icon-btn" title="Settings" @click="openSettings">⚙</button>
        </div>

        <div class="chat-area" ref="chatAreaRef" @click="onChatClick">
          <div v-if="!messages.length && !liveAssistant.visible" class="empty-state">
            <h2>PumpApi Agent</h2>
            <div>Send a message to start chatting with Hermes.</div>
          </div>
          <div v-else class="msg-list">
            <div v-for="m in messages" :key="m.id" class="msg-row" :class="m.role">
              <div v-if="editingMessageId === m.id" class="msg-edit bubble">
                <textarea v-model="editingValue"></textarea>
                <div v-if="editingAttachments.length" class="msg-attachments">
                  <template v-for="(a, i) in editingAttachments" :key="i">
                    <span v-if="a.type === 'text'" class="att-pill">
                      📄 {{ a.filename }}
                      <button class="att-x" @click="removeEditAttachment(m, i)" style="background:transparent;border:none;color:#999;cursor:pointer;margin-left:6px;">✕</button>
                    </span>
                    <span v-else-if="a.type === 'image'" class="att-pill">
                      🖼 {{ a.filename }}
                      <button class="att-x" @click="removeEditAttachment(m, i)" style="background:transparent;border:none;color:#999;cursor:pointer;margin-left:6px;">✕</button>
                    </span>
                  </template>
                </div>
                <div class="msg-edit-actions">
                  <button @click="cancelEdit">Cancel</button>
                  <button class="primary" @click="saveEdit(m)">Save & resend</button>
                </div>
              </div>
              <template v-else>
                <!-- Saved tool events: collapsed by default. Click the chevron to expand. -->
                <div v-if="m.role === 'assistant' && m.tool_events && m.tool_events.length"
                     class="tools-collapsible" :class="{ open: isToolsExpanded(m) }">
                  <button class="tools-toggle" @click="toggleTools(m)" :title="isToolsExpanded(m) ? 'Hide tool calls' : 'Show tool calls'">
                    <span class="chev">▸</span>
                    <span>🔧 Used {{ m.tool_events.length }} tool{{ m.tool_events.length === 1 ? '' : 's' }}</span>
                  </button>
                  <div v-if="isToolsExpanded(m)" class="tools-list">
                    <div v-for="t in m.tool_events" :key="t.toolCallId"
                         class="tool-progress" :class="{ completed: t.status === 'completed' }">
                      {{ t.emoji }} {{ t.status === 'completed' ? 'Done:' : 'Running' }} {{ t.tool || t.name }}: {{ t.label }}
                    </div>
                  </div>
                </div>
                <div class="bubble" v-html="renderMarkdown(m.content)"></div>
              </template>
              <div v-if="editingMessageId !== m.id && m.attachments && m.attachments.length" class="msg-attachments">
                <template v-for="(a, i) in m.attachments" :key="i">
                  <img v-if="a.type === 'image' && a.data_uri" class="thumb-img" :src="a.data_uri" @click="lightboxUrl = a.data_uri" />
                  <span v-else-if="a.type === 'text'" class="att-pill" @click="openTextPreview(a, 'preview', false)" style="cursor:pointer;">
                    📄 {{ a.filename }} ({{ Math.round((a.size||0)/100)/10 }}k)
                  </span>
                </template>
              </div>
              <div v-if="editingMessageId !== m.id" class="msg-actions">
                <span v-if="m.created_at" class="msg-timestamp" :title="formatTimestamp(m.created_at, true)">{{ formatTimestamp(m.created_at) }}</span>
                <button class="icon-action" @click="copyMessage(m)" title="Copy">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button v-if="m.role === 'user'" class="icon-action" @click="startEdit(m)" title="Edit">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <span v-if="m.role === 'user' && m.version_count && m.version_count > 1" class="version-nav">
                  <button class="icon-action" @click="switchVersion(m, -1)" :disabled="(m.version_index ?? 0) === 0" title="Previous version">‹</button>
                  <span class="version-counter">{{ (m.version_index ?? 0) + 1 }}/{{ m.version_count }}</span>
                  <button class="icon-action" @click="switchVersion(m, +1)" :disabled="(m.version_index ?? 0) >= m.version_count - 1" title="Next version">›</button>
                </span>
              </div>
            </div>

            <!-- Live streaming assistant -->
            <div v-if="liveAssistant.visible" class="msg-row assistant">
              <div v-for="t in liveAssistant.tools" :key="t.toolCallId"
                   class="tool-progress" :class="{ completed: t.status === 'completed' }">
                {{ t.emoji }} {{ t.status === 'completed' ? 'Done:' : 'Running' }} {{ t.name }}: {{ t.label }}
              </div>
              <div class="bubble" :class="{ 'cursor-blink': streaming }" v-html="renderMarkdown(liveAssistant.content)"></div>
            </div>
          </div>
        </div>

        <!-- Input bar -->
        <div class="input-bar-wrap">
          <div v-if="errorBanner" class="error-banner" :class="'banner-' + (errorBanner.kind || 'error')">
            <div class="error-banner-body">
              <div class="error-banner-title">{{ (errorBanner.kind === 'info' ? '✓ ' : '⚠ ') + errorBanner.title }}</div>
              <div v-if="errorBanner.detail" class="error-banner-detail">{{ errorBanner.detail }}</div>
            </div>
            <button class="error-banner-close" @click="dismissError" title="Dismiss">✕</button>
          </div>
          <div class="input-bar-inner">
            <div v-if="draftAttachments.length" class="attachments-row">
              <template v-for="(a, i) in draftAttachments" :key="i">
                <div v-if="a.kind === 'image'" class="att-pill-input image" @click="lightboxUrl = a.dataUri">
                  <img :src="a.dataUri" />
                  <button class="att-x" @click.stop="removeAttachment(i)">✕</button>
                </div>
                <div v-else class="att-pill-input" @click="openTextPreview(a, 'text', true)">
                  <span class="att-name">📄 {{ a.filename }} ({{ Math.round((a.size||0)/100)/10 }}k)</span>
                  <button class="att-x" @click.stop="removeAttachment(i)">✕</button>
                </div>
              </template>
            </div>
            <div class="input-bar">
              <button class="icon-btn attach" @click="pickFile" title="Attach file">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </button>
              <textarea
                ref="textareaRef"
                v-model="draft"
                placeholder="Message PumpApi Agent..."
                rows="1"
                @input="autoResize"
                @keydown="onKeydown"
                @paste="onPaste"
              ></textarea>
              <button v-if="!streaming" class="icon-btn" @click="send" :disabled="!draft.trim() && !draftAttachments.length" title="Send">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
              <button v-else class="icon-btn" @click="abortStream" title="Stop">
                <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              </button>
            </div>
          </div>
        </div>
      </main>

      <!-- Lightbox -->
      <div v-if="lightboxUrl" class="lightbox" @click="lightboxUrl = null">
        <button class="lb-close" @click.stop="lightboxUrl = null">✕</button>
        <img :src="lightboxUrl" />
      </div>

      <!-- Text preview modal -->
      <div v-if="textPreview" class="modal-backdrop" @click="textPreview = null">
        <div class="modal text-preview-modal" @click.stop>
          <h2>{{ textPreview.filename }}</h2>
          <textarea
            v-if="textPreview.target"
            class="text-preview-area"
            v-model="textPreview.content"
            spellcheck="false"
            wrap="off"
          ></textarea>
          <pre v-else class="text-preview-area readonly">{{ textPreview.content }}</pre>
          <div class="modal-actions">
            <button v-if="textPreview.target" class="primary" @click="saveTextPreview">Save</button>
            <button @click="textPreview = null">Close</button>
          </div>
        </div>
      </div>

      <!-- Confirm dialog -->
      <div v-if="confirm" class="modal-backdrop" @click="confirm = null">
        <div class="modal confirm-modal" @click.stop>
          <h2>Confirm</h2>
          <p>{{ confirm.message }}</p>
          <div class="modal-actions">
            <button @click="confirm = null">Cancel</button>
            <button :class="confirm.danger === false ? 'primary' : 'primary danger'" @click="confirm.onYes">{{ confirm.confirmLabel || 'Delete' }}</button>
          </div>
        </div>
      </div>

      <!-- Settings hub: tiles → sub-modals.
           Top section pushes messenger linking as the headline action;
           memory/skills/tools/mcp are secondary tiles. -->
      <div v-if="settingsOpen" class="modal-backdrop" @click="settingsOpen = false">
        <div class="modal settings-hub" @click.stop>
          <h2>Settings</h2>

          <div class="settings-section-title">🔌 Link a messenger</div>
          <p class="settings-hint">Connect a messenger and chat with the agent directly from it — no need to open this site.</p>
          <div class="settings-tiles">
            <button class="settings-tile messenger" @click="panel = 'telegram'">
              <span class="tile-icon">✈️</span>
              <span class="tile-body">
                <span class="tile-title">Telegram</span>
                <span class="tile-sub">{{ messengerStatus.telegram ? 'Connected' : 'Not linked' }}</span>
              </span>
              <span class="tile-badge" :class="messengerStatus.telegram ? 'on' : 'off'"></span>
            </button>
            <button class="settings-tile messenger" @click="panel = 'discord'">
              <span class="tile-icon">🎮</span>
              <span class="tile-body">
                <span class="tile-title">Discord</span>
                <span class="tile-sub">{{ messengerStatus.discord ? 'Connected' : 'Not linked' }}</span>
              </span>
              <span class="tile-badge" :class="messengerStatus.discord ? 'on' : 'off'"></span>
            </button>
            <button class="settings-tile messenger" @click="panel = 'whatsapp'">
              <span class="tile-icon">💬</span>
              <span class="tile-body">
                <span class="tile-title">WhatsApp</span>
                <span class="tile-sub">{{ messengerStatus.whatsapp ? 'Connected' : 'Not linked' }}</span>
              </span>
              <span class="tile-badge" :class="messengerStatus.whatsapp ? 'on' : 'off'"></span>
            </button>
          </div>

          <div class="settings-section-title">🧠 Agent brain</div>
          <div class="settings-tiles">
            <button class="settings-tile" @click="openMemory('MEMORY')">
              <span class="tile-icon">💾</span>
              <span class="tile-body">
                <span class="tile-title">Memory</span>
                <span class="tile-sub">What the agent remembers about your environment</span>
              </span>
            </button>
            <button class="settings-tile" @click="openMemory('USER')">
              <span class="tile-icon">👤</span>
              <span class="tile-body">
                <span class="tile-title">About you</span>
                <span class="tile-sub">What the agent knows about you</span>
              </span>
            </button>
            <button class="settings-tile" @click="openSkills">
              <span class="tile-icon">📚</span>
              <span class="tile-body">
                <span class="tile-title">Skills</span>
                <span class="tile-sub">Installed skill packs</span>
              </span>
            </button>
            <button class="settings-tile" @click="openTools">
              <span class="tile-icon">🛠️</span>
              <span class="tile-body">
                <span class="tile-title">Tools</span>
                <span class="tile-sub">Built-in toolsets (web, browser, terminal…)</span>
              </span>
            </button>
            <button class="settings-tile" @click="openMcp">
              <span class="tile-icon">🔗</span>
              <span class="tile-body">
                <span class="tile-title">MCP servers</span>
                <span class="tile-sub">External Model Context Protocol sources</span>
              </span>
            </button>
          </div>

          <div class="settings-section-title">👤 Account</div>
          <div class="field">
            <label>API Key</label>
            <div class="api-key-row">
              <input type="text" :value="apiKeyVisible ? apiKey : maskedKey(apiKey)" readonly />
              <button @click="apiKeyVisible = !apiKeyVisible">{{ apiKeyVisible ? '🙈' : '👁' }}</button>
            </div>
          </div>

          <div class="modal-actions">
            <button @click="settingsOpen = false">Close</button>
          </div>
        </div>
      </div>

      <!-- Telegram sub-modal -->
      <div v-if="settingsOpen && panel === 'telegram'" class="modal-backdrop" @click="panel = null">
        <div class="modal" @click.stop>
          <h2>✈️ Link Telegram</h2>
          <ol class="settings-steps">
            <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> in Telegram and send <code>/newbot</code>. Pick a name and username, then copy the HTTP API token it gives you.</li>
            <li>Find your own user ID with <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> — start a chat with it and it replies with your numeric ID.</li>
            <li>Paste both below and save. Then open your new bot in Telegram and message it like a normal contact.</li>
          </ol>
          <div class="field">
            <label>Bot Token</label>
            <input type="text" v-model="settings.TELEGRAM_BOT_TOKEN" placeholder="123456:ABC-DEF..." />
          </div>
          <div class="field">
            <label>Allowed User IDs <span class="help-tip" data-tip="Comma-separated Telegram numeric IDs (from @userinfobot). Leave empty to let anyone talk to the bot — not recommended.">?</span></label>
            <input type="text" v-model="settings.TELEGRAM_ALLOWED_USERS" placeholder="123456789,987654321" />
          </div>
          <div class="modal-actions">
            <button @click="panel = null">Cancel</button>
            <button class="primary" @click="saveSection('Telegram')">Save and link</button>
          </div>
        </div>
      </div>

      <!-- Discord sub-modal -->
      <div v-if="settingsOpen && panel === 'discord'" class="modal-backdrop" @click="panel = null">
        <div class="modal" @click.stop>
          <h2>🎮 Link Discord</h2>
          <ol class="settings-steps">
            <li>Go to <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers/applications</a> → <strong>New Application</strong> → <strong>Bot</strong> → <strong>Reset Token</strong>. Copy the token.</li>
            <li>On the same Bot page, enable the <strong>Message Content Intent</strong> toggle (required for DMs and mentions).</li>
            <li>Get your Discord user ID: Settings → Advanced → enable <strong>Developer Mode</strong>, then right-click your name anywhere → <strong>Copy User ID</strong>.</li>
            <li>Invite the bot to a server via OAuth2 → URL Generator → scopes <code>bot</code>, then open the generated URL.</li>
            <li>Paste token and IDs below.</li>
          </ol>
          <div class="field">
            <label>Bot Token</label>
            <input type="text" v-model="settings.DISCORD_BOT_TOKEN" placeholder="MTk0..." />
          </div>
          <div class="field">
            <label>Allowed User IDs <span class="help-tip" data-tip="Comma-separated Discord numeric IDs (Developer Mode → right-click → Copy User ID). Empty = allow anyone.">?</span></label>
            <input type="text" v-model="settings.DISCORD_ALLOWED_USERS" placeholder="123456789012345678,987654321098765432" />
          </div>
          <div class="modal-actions">
            <button @click="panel = null">Cancel</button>
            <button class="primary" @click="saveSection('Discord')">Save and link</button>
          </div>
        </div>
      </div>

      <!-- WhatsApp sub-modal -->
      <div v-if="settingsOpen && panel === 'whatsapp'" class="modal-backdrop" @click="panel = null">
        <div class="modal" @click.stop>
          <h2>💬 Link WhatsApp</h2>
          <ol class="settings-steps">
            <li>Sign up at <a href="https://www.twilio.com/try-twilio" target="_blank" rel="noopener">twilio.com</a>, then open the console.</li>
            <li>Console → <strong>Messaging → Try it out → Send a WhatsApp message</strong>. Activate the WhatsApp sandbox and follow the instructions (you'll send a code from your phone).</li>
            <li>From the console copy your <strong>Account SID</strong>, <strong>Auth Token</strong>, and the sandbox <strong>From number</strong> (looks like <code>+141****8886</code>).</li>
            <li><strong>Home number</strong> = your own WhatsApp number in E.164 format (with country code, e.g. <code>+155****4567</code>).</li>
          </ol>
          <div class="field">
            <label>Twilio Account SID</label>
            <input type="text" v-model="settings.WHATSAPP_ACCOUNT_SID" placeholder="ACxxxxxxxx..." />
          </div>
          <div class="field">
            <label>Twilio Auth Token</label>
            <input type="text" v-model="settings.WHATSAPP_AUTH_TOKEN" />
          </div>
          <div class="field">
            <label>From Number (Twilio sandbox number)</label>
            <input type="text" v-model="settings.WHATSAPP_FROM_NUMBER" placeholder="+141****8886" />
          </div>
          <div class="field">
            <label>Home Number (your personal WhatsApp)</label>
            <input type="text" v-model="settings.WHATSAPP_HOME_NUMBER" placeholder="+155****4567" />
          </div>
          <div class="modal-actions">
            <button @click="panel = null">Cancel</button>
            <button class="primary" @click="saveSection('WhatsApp')">Save and link</button>
          </div>
        </div>
      </div>

      <!-- Memory editor sub-modal -->
      <div v-if="settingsOpen && panel === 'memory' && memEditor" class="modal-backdrop" @click="memEditor = null; panel = null">
        <div class="modal modal-wide" @click.stop>
          <h2>{{ memEditor.target === 'USER' ? '👤 About you' : '💾 Agent memory' }}</h2>
          <p class="settings-hint">
            {{ memEditor.target === 'USER'
              ? 'Facts the agent should know about you: preferences, communication style, habits, timezone.'
              : "The agent's notes about your environment: project facts, tool quirks, conventions." }}
            This is a plain markdown file — write freely, one thought per line or as a paragraph.
          </p>
          <textarea v-model="memEditor.content" class="memory-editor" placeholder="e.g. User prefers concise responses. Timezone: Europe/Moscow. Project uses pytest with xdist."></textarea>
          <div class="modal-actions">
            <button @click="memEditor = null; panel = null">Cancel</button>
            <button class="primary" @click="saveMemory">Save</button>
          </div>
        </div>
      </div>

      <!-- Skills sub-modal -->
      <div v-if="settingsOpen && panel === 'skills'" class="modal-backdrop" @click="panel = null">
        <div class="modal modal-wide" @click.stop>
          <h2>📚 Skills</h2>
          <p class="settings-hint">Skills are instructions the agent loads when relevant (a "how to do X" playbook). <button class="link-btn" @click="startSkillImport">+ Add skill</button></p>
          <div v-if="skillsLoading" class="settings-hint">Loading…</div>
          <div v-else class="skills-list">
            <div v-for="s in skillsList" :key="(s.category || '') + '/' + s.name" class="skill-row">
              <div class="skill-meta" @click="viewSkill(s.name)">
                <div class="skill-name">{{ s.name }} <span v-if="s.category" class="skill-cat">{{ s.category }}</span><span v-if="s.bundled" class="skill-cat" title="Ships with the agent — can't be removed">bundled</span></div>
                <div class="skill-desc">{{ s.description || '—' }}</div>
              </div>
              <button v-if="!s.bundled" class="icon-btn danger" @click.stop="deleteSkill(s.name)" title="Remove">🗑</button>
            </div>
            <div v-if="!skillsList.length" class="settings-hint">No skills installed.</div>
          </div>
          <div class="modal-actions">
            <button @click="panel = null">Close</button>
          </div>
        </div>
      </div>

      <!-- Skill viewer/editor. Non-bundled skills are editable in place;
           bundled ones stay read-only (next agent update would clobber edits). -->
      <div v-if="skillPreview" class="modal-backdrop" @click="closeSkillPreview">
        <div class="modal modal-wide" @click.stop>
          <h2>{{ skillPreview.name }}<span v-if="!skillPreview.editable" class="skill-cat" style="margin-left:8px">read-only</span></h2>
          <p v-if="!skillPreview.editable" class="settings-hint">This skill ships with the agent and can't be edited here — duplicate it under a new name to customize.</p>
          <textarea v-model="skillPreview.content" class="memory-editor" :readonly="!skillPreview.editable"></textarea>
          <div class="modal-actions">
            <button @click="closeSkillPreview" :disabled="skillPreview.saving">{{ skillPreview.editable && skillPreview.content !== skillPreview.original ? 'Cancel' : 'Close' }}</button>
            <button v-if="skillPreview.editable" class="primary" @click="saveSkillEdit" :disabled="skillPreview.saving || skillPreview.content === skillPreview.original || !skillPreview.content.trim()">{{ skillPreview.saving ? 'Saving…' : 'Save' }}</button>
          </div>
        </div>
      </div>

      <!-- Skill importer (paste OR github URL) -->
      <div v-if="skillImporter" class="modal-backdrop" @click="!skillImporter.busy && (skillImporter = null)">
        <div class="modal modal-wide" @click.stop>
          <h2>+ Add skill</h2>
          <div class="tab-bar">
            <button :class="{ active: skillImporter.source === 'paste' }" @click="skillImporter.source = 'paste'">📋 Paste SKILL.md</button>
            <button :class="{ active: skillImporter.source === 'github' }" @click="skillImporter.source = 'github'">🐙 From GitHub</button>
          </div>
          <div v-if="skillImporter.source === 'paste'">
            <p class="settings-hint">Paste a complete <code>SKILL.md</code> (markdown with YAML frontmatter). It will be saved to <code>~/.hermes/skills/local/&lt;name&gt;/</code>.</p>
            <div class="field">
              <label>Name (lowercase, a-z 0-9 _ -)</label>
              <input type="text" v-model="skillImporter.name" placeholder="my-skill" />
            </div>
            <textarea v-model="skillImporter.content" class="memory-editor" placeholder="--- name: my-skill --- ## When to use ..."></textarea>
          </div>
          <div v-else>
            <p class="settings-hint">GitHub URL or <code>owner/repo</code> — runs <code>hermes skills install &lt;url&gt;</code>.</p>
            <div class="field">
              <label>GitHub URL or owner/repo</label>
              <input type="text" v-model="skillImporter.url" placeholder="https://github.com/owner/repo" />
            </div>
          </div>
          <div class="modal-actions">
            <button @click="skillImporter = null" :disabled="skillImporter.busy">Cancel</button>
            <button class="primary" @click="submitSkillImport" :disabled="skillImporter.busy">{{ skillImporter.busy ? 'Installing…' : 'Install' }}</button>
          </div>
        </div>
      </div>

      <!-- Tools sub-modal -->
      <div v-if="settingsOpen && panel === 'tools'" class="modal-backdrop" @click="panel = null">
        <div class="modal modal-wide" @click.stop>
          <h2>🛠️ Tools</h2>
          <p class="settings-hint">Toggle built-in toolsets. The agent restarts briefly after each change so the new set takes effect.</p>
          <div v-if="toolsLoading" class="settings-hint">Loading…</div>
          <div v-else class="tools-list">
            <label v-for="t in toolsList" :key="t.name" class="tool-row">
              <input type="checkbox" :checked="t.enabled" @change="toggleTool(t)" />
              <span class="tool-label">{{ t.label }}</span>
              <span class="tool-name">{{ t.name }}</span>
            </label>
          </div>
          <div class="modal-actions">
            <button @click="panel = null">Close</button>
          </div>
        </div>
      </div>

      <!-- MCP sub-modal -->
      <div v-if="settingsOpen && panel === 'mcp'" class="modal-backdrop" @click="panel = null">
        <div class="modal modal-wide" @click.stop>
          <h2>🔗 MCP servers</h2>
          <p class="settings-hint">
            MCP (Model Context Protocol) servers expose extra tools to the agent. Try the free
            <button class="link-btn" @click="startMcpAdd('deepwiki', 'https://mcp.deepwiki.com/mcp')">DeepWiki</button>
            preset, or <button class="link-btn" @click="startMcpAdd()">+ add your own</button>.
          </p>
          <div v-if="mcpEmpty" class="settings-hint">No MCP servers configured.</div>
          <div v-else class="skills-list">
            <div v-for="srv in mcpList" :key="srv.name || srv" class="skill-row">
              <div class="skill-meta"><div class="skill-name">{{ srv.name || srv }}<span v-if="srv.url" class="skill-cat">{{ srv.url }}</span></div></div>
              <button v-if="srv.name" class="icon-btn danger" @click="removeMcp(srv.name)" title="Remove">🗑</button>
            </div>
          </div>
          <div class="modal-actions">
            <button @click="panel = null">Close</button>
          </div>
        </div>
      </div>

      <!-- MCP add form -->
      <div v-if="mcpForm" class="modal-backdrop" @click="!mcpForm.busy && (mcpForm = null)">
        <div class="modal" @click.stop>
          <h2>+ Add MCP server</h2>
          <p class="settings-hint">Free public MCP servers you can try: <code>https://mcp.deepwiki.com/mcp</code> (GitHub docs Q&amp;A), <code>https://gitmcp.io/&lt;owner&gt;/&lt;repo&gt;</code> (any GitHub repo).</p>
          <div class="field">
            <label>Name (short identifier)</label>
            <input type="text" v-model="mcpForm.name" placeholder="deepwiki" />
          </div>
          <div class="field">
            <label>URL (HTTP / SSE endpoint)</label>
            <input type="text" v-model="mcpForm.url" placeholder="https://mcp.deepwiki.com/mcp" />
          </div>
          <div class="modal-actions">
            <button @click="mcpForm = null" :disabled="mcpForm.busy">Cancel</button>
            <button class="primary" @click="submitMcpAdd" :disabled="mcpForm.busy">{{ mcpForm.busy ? 'Adding…' : 'Add' }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
};

createApp(App).mount('#app');
