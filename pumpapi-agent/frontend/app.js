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
    const selectedModel = ref(localStorage.getItem('papi_model') || 'hermes-agent');
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
        const m = await api('/api/models');
        if (Array.isArray(m) && m.length) {
          models.value = m;
          if (!m.find(x => x.id === selectedModel.value)) {
            selectedModel.value = m[0].id;
            localStorage.setItem('papi_model', selectedModel.value);
          }
        }
      } catch (e) { /* ignore */ }
    }
    watch(selectedModel, (v) => localStorage.setItem('papi_model', v));

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

    async function openChat(id) {
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
      settingsOpen.value = true;
    }
    async function saveSettings() {
      try {
        const r = await api('/api/settings', { method: 'POST', body: JSON.stringify({ ...settings }) });
        if (r && r.changed && r.changed.length) {
          if (r.gateway_restarted) {
            toast(`Saved · gateway restarted (${r.changed.join(', ')})`);
          } else {
            toast(`Saved, but gateway restart failed: ${r.gateway_error || 'unknown'}`, 'error');
          }
        } else {
          toast('Saved (no changes)');
        }
      } catch (e) {
        toast(`Save failed: ${e.message || e}`, 'error');
        return;
      }
      settingsOpen.value = false;
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
      openSettings, saveSettings, maskedKey,
      renderMarkdown, escapeHtml,
      switchVersion, toggleTools, isToolsExpanded,
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
          <select class="model-select" v-model="selectedModel">
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
              <div v-if="m.role === 'user' && editingMessageId !== m.id" class="msg-actions">
                <span v-if="m.created_at" class="msg-timestamp" :title="formatTimestamp(m.created_at, true)">{{ formatTimestamp(m.created_at) }}</span>
                <button class="icon-action" @click="startEdit(m)" title="Edit">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
                <span v-if="m.version_count && m.version_count > 1" class="version-nav">
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
            <button class="primary danger" @click="confirm.onYes">Delete</button>
          </div>
        </div>
      </div>

      <!-- Settings modal -->
      <div v-if="settingsOpen" class="modal-backdrop" @click="settingsOpen = false">
        <div class="modal" @click.stop>
          <h2>Settings</h2>

          <h3>Telegram</h3>
          <div class="field">
            <label>Bot Token <span class="help-tip" data-tip="Create a bot via @BotFather on Telegram → /newbot → copy the HTTP API token.">?</span></label>
            <input type="text" v-model="settings.TELEGRAM_BOT_TOKEN" placeholder="123456:ABC-..." />
          </div>
          <div class="field">
            <label>Allowed Users <span class="help-tip" data-tip="Comma-separated Telegram user IDs allowed to chat with the bot. Get yours from @userinfobot. Example: 123456789,987654321. Leave empty to allow anyone (not recommended).">?</span></label>
            <input type="text" v-model="settings.TELEGRAM_ALLOWED_USERS" placeholder="123456789,987654321" />
          </div>

          <h3>Discord</h3>
          <div class="field">
            <label>Bot Token <span class="help-tip" data-tip="Create an app at https://discord.com/developers/applications → Bot → Reset Token. Enable Message Content intent.">?</span></label>
            <input type="text" v-model="settings.DISCORD_BOT_TOKEN" placeholder="MTk0..." />
          </div>
          <div class="field">
            <label>Allowed Users <span class="help-tip" data-tip="Comma-separated Discord user IDs allowed to DM/mention the bot. Enable Developer Mode in Discord settings → right-click your name → Copy User ID. Example: 123456789012345678,987654321098765432.">?</span></label>
            <input type="text" v-model="settings.DISCORD_ALLOWED_USERS" placeholder="123456789012345678,987..." />
          </div>

          <h3>WhatsApp</h3>
          <div class="field">
            <label>Twilio Account SID <span class="help-tip" data-tip="Twilio console → Account → API Credentials → Account SID. Use Sandbox for testing.">?</span></label>
            <input type="text" v-model="settings.WHATSAPP_ACCOUNT_SID" placeholder="ACxxxxxxxx..." />
          </div>
          <div class="field">
            <label>Twilio Auth Token <span class="help-tip" data-tip="Same page as Account SID; click 'Show' to reveal. Treat as a password.">?</span></label>
            <input type="text" v-model="settings.WHATSAPP_AUTH_TOKEN" />
          </div>
          <div class="field">
            <label>From Number <span class="help-tip" data-tip="Your Twilio WhatsApp number in E.164 format, e.g. +14155238886 (sandbox).">?</span></label>
            <input type="text" v-model="settings.WHATSAPP_FROM_NUMBER" placeholder="+14155238886" />
          </div>
          <div class="field">
            <label>Home Number <span class="help-tip" data-tip="Your personal WhatsApp number that should receive notifications, in E.164 format.">?</span></label>
            <input type="text" v-model="settings.WHATSAPP_HOME_NUMBER" placeholder="+15551234567" />
          </div>

          <h3>Account</h3>
          <div class="field">
            <label>API Key</label>
            <div class="api-key-row">
              <input type="text" :value="maskedKey(apiKey)" readonly />
              <button @click="apiKeyVisible = !apiKeyVisible">{{ apiKeyVisible ? '🙈' : '👁' }}</button>
            </div>
          </div>

          <div class="modal-actions">
            <button @click="settingsOpen = false">Cancel</button>
            <button class="primary" @click="saveSettings">Save</button>
          </div>
        </div>
      </div>
    </div>
  `,
};

createApp(App).mount('#app');
